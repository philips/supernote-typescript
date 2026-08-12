/**
 * Builds the fixture comparison site: for every fixture that ships with
 * Supernote's own PDF export, each page's device-drawn vector ink next to
 * what `toSvg({ vectorInk: true })` produces.
 *
 * Both sides are real SVG and both are ink only -- the device's ink lives in
 * a Form XObject separate from the page's background image, so ours has its
 * background raster stripped to match. What's left on each side is exactly
 * the vector ink, which is the thing being judged.
 *
 * Run with `npm run build:site`; output lands in `site/`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SupernoteX } from '../src/parsing.js';
import { toSvg } from '../src/svg.js';
import { extractPageForms, pdfPageToSvg, devicePageToSvgDocument } from './pdf-vector.js';

const INPUT_DIR = 'tests/input';
const OUT_DIR = 'site';

/** The site is published to GitHub Pages on its own domain, so nothing on it
 * points back at the code by default. Both links are absolute for that reason.
 * They pin to `main` rather than a tag: what the site shows is whatever `main`
 * currently renders, so the spec beside it should track the same branch. */
const REPO_URL = 'https://github.com/philips/supernote-typescript';
const SPEC_URL = `${REPO_URL}/blob/main/plans/vector-format-spec.md`;

/** Closes out every page's footer. The comparison only means anything if you
 * can get from a suspicious-looking page to the format notes explaining what
 * the decoder thought it was reading. */
const COLOPHON = `<p class="colophon"><a href="${REPO_URL}">supernote-typescript on GitHub</a> <span aria-hidden="true">&middot;</span> <a href="${SPEC_URL}">Vector format spec</a></p>`;

/** What each fixture is for, and anything notable about how it renders.
 * Fixtures with nothing recorded here still appear; they just carry no note. */
const FIXTURE_NOTES: Record<string, { isolates: string; note?: string }> = {
	'straight-line': {
		isolates: 'The ruler tool — the only fixture producing stroke_kind "straightLine".',
		note: 'These records store just two endpoints, and any two-point record used to be read as a filled rectangle, so page 1\'s six lines rendered as three degenerate invisible boxes. Rect-ness now comes from the record\'s own stroke_kind.',
	},
	horizontal_1270: {
		isolates: 'Erasing, with the tightest ground truth here — its PDF names stroke by stroke what survived.',
		note: 'Draws exactly the 61 of 82 decoded strokes the device does. The doubled "0" in "1270" is gone: that digit was written, erased and rewritten in place, so the erased copy still found about 30% of its own points over black ink.',
	},
	test: {
		isolates: 'The oldest file here (SN_FILE_VER_20220011, A5X) — the only one on the older ids: ink pen 1, marker 5, and colours stored as palette ids rather than greys.',
		note: 'Its three pen=5 strokes are a highlighter pass over the first line, which is what identifies 5 as the marker. Its export is also what decoded the old colour ids: 48 is dark grey and 81 light grey, each device colour group landing on one of ours to within a stroke half width. Reading them literally made dark grey nearly black and cost the page 16 of its 58 strokes, which the ink-presence check dropped as invisible after hunting for a shade the raster never held.',
	},
	'a5x-2.14.28': {
		isolates: 'The older ink pen (pen=1), and a rare 1:1 export — 146 filled outlines for 146 decoded strokes.',
		note: 'This pen renders about twice its nominal width. Drawing at nominal laid down 40% of the device\'s ink; measuring each stroke\'s own contour brings that to 84%.',
	},
	caligraphy: {
		isolates: 'The calligraphy pen at three width settings; page 4 is a page erased down to one word.',
		note: 'A chisel nib lays down far less ink than its width implies — the opposite of the ink pen. Nominal covered about 1.9x the device\'s ink.',
	},
	'stroke-isolation': {
		isolates: 'One variable per page: page 2 the pen tools, page 3 colours, page 4 width settings, page 5 marker black and white.',
		note: 'Page 4 is the width calibration. Its PDF states each width as a number rather than drawing an outline — 12, 7, 4, 2 — and widths measured from the contour land on 12.01, 7.02, 4.05, 1.99 without consulting the pen or the thickness setting.',
	},
	'erase-pen': {
		isolates: 'Erasing with a white pen rather than the eraser tool. Page 4 is the control, dark ink only.',
		note: 'Not erasing in the format\'s terms: both strokes are ordinary ink, and the page is right as long as the white is painted after the dark — which is what the device\'s own export does.',
	},
	'erase-colors': {
		isolates: 'Grey marker bands through black pen writing, then erased. Page 1 is the control, no erasers.',
		note: 'The case that would catch the survival check\'s colour matching being too loose. The control matching the erased page is what shows erasing is not skewing the result.',
	},
	erase: {
		isolates: 'Every erase mechanism on one page, plus white-ink cover-ups.',
		note: 'All ten dark strokes were erased, so only the four white cover-up strokes render — which is also all the device draws.',
	},
	'erase-no-white-pen': {
		isolates: 'Four pens, every stroke erased, no white-ink cover-ups.',
		note: 'Renders blank on purpose, and the device\'s export draws nothing either — so this page has no vector ink on either side.',
	},
	'headings-and-marker': {
		isolates: 'The Heading feature — four background styles — separated from the marker tool.',
		note: 'Heading fills and their auto-contrast label colours come from the note\'s own TITLE_ footer metadata, giving the exact design palette rather than the raster\'s quantised greys.',
	},
	sticker: {
		isolates: 'The sticker plugin — artwork placed as ordinary stroke records, in a shape the centreline model cannot express.',
		note: 'The one page whose ratio is wrong about it. Page 2\'s sticker is filled the way a person fills a shape with a pen, black strokes doubling back over themselves with white carved back over the top, so our 22 overlapping outlines get summed where the device\'s export merges its black into a single path counted once. Rasterised instead of summed, the ink we lay down covers 42,704 square pixels against the device\'s 42,800 — the picture agrees even where the number says 1.36×. The black marker line across it is also what settled draw order: sorting every marker under the pen ink drew the sticker over the line, where the device draws the line over the sticker.',
	},
	turkish: {
		isolates: 'Dense handwriting with erasures throughout, then rewritten in place.',
		note: 'Long read as the case no cutoff could get right, because survival measured across its erased strokes runs smoothly from 0% to 95%. It was measuring the replacement: the device draws 152 paths for the 152 records reading m_trailStatus 0, and none of the 37 marked ones.',
	},
	'nomad-3.26.40-link-tag-3p': {
		isolates: 'Partial erasing — the one firmware that splits a stroke instead of removing it, and stores what it left behind.',
		note: 'Page 2 settles what a partial erase looks like: each erased line is marked and the pieces the eraser left are written as separate records carrying only an outline. The device draws exactly those pieces — 5, 4, 4, 5, 5, 5, 5 of them across its seven lines, at the same positions to the pixel — and never the line they came from. Page 3 erases and rewrites in place, where a stroke\'s own ink and its replacement\'s sit on top of each other; the export draws 113 paths for its 113 live records.',
	},
	'nomad-3.15.27-blank-shapes-and-RTR': { isolates: 'Shapes, patterns, Headings and keyword highlighting.' },
	'nomad-3.26.40-blank-2p': {
		isolates: 'An export that draws nothing at all, on either of its pages.',
		note: 'Blank on both sides is a result here, not a gap — the device\'s export carries no vector ink for either page, and neither do we. It reads as the weakest fixture and is closer to the opposite: nothing else in the corpus states outright that a page is empty.',
	},
	'erase-partial2': { isolates: 'A page erased by selecting and deleting, which removes the records outright.' },
};

/** Fixtures worth seeing first — the rest follow alphabetically. */
const FEATURED = [
	'straight-line', 'horizontal_1270', 'a5x-2.14.28', 'caligraphy',
	'stroke-isolation', 'erase-pen', 'erase-colors', 'erase', 'erase-no-white-pen',
	'headings-and-marker', 'sticker', 'turkish',
];

const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '_');

/** Ink a rendered SVG lays down, in square page pixels: a filled path's
 * enclosed area, a stroked path's length times its width, plus the area of
 * any filled rect. Deliberately measured off the finished SVG rather than
 * from internals, so it compares like for like with the same measure taken
 * from the device's PDF -- which is drawn in both of those styles too, and
 * measured the same two ways (see `pdf-vector.ts`).
 *
 * Both styles are needed on our side as well: a stroke is normally drawn as
 * the device's own rendered outline, filled, and only falls back to a
 * stroked centreline where the record carries no usable contour. Summing
 * rings *signed* is what makes a filled path's holes subtract rather than
 * add -- the gap inside an `e` or an `o` is stored as its own
 * oppositely-wound ring.
 *
 * Pure white (255) is skipped: those are the overlays drawn along an
 * eraser's own path to cover what it took out, so counting them would add
 * ink where the point was to remove it -- on a page erased with a wide
 * eraser they swamp everything else. White *ink* is a different thing and
 * still counts, which is why the test is exact rather than "near white":
 * the white pen records 254, and the device's export draws it too. */
function svgInkArea(svg: string): number {
	const ringsOf = (d: string) =>
		d
			.split('M')
			.filter((segment) => segment.trim())
			.map((segment) => [...segment.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]));
	const signedArea = (ring: number[][]) => {
		let sum = 0;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
		}
		return sum / 2;
	};

	let total = 0;
	for (const [, d, attrs] of svg.matchAll(/<path d="([^"]+)"([^>]*)\/>/g)) {
		const rings = ringsOf(d);
		const stroke = /stroke="([^"]+)"/.exec(attrs)?.[1];
		if (stroke) {
			if (stroke === 'rgb(255,255,255)') continue;
			const width = Number(/stroke-width="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
			for (const ring of rings) {
				let length = 0;
				for (let i = 1; i < ring.length; i++) length += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
				total += length * width;
			}
			continue;
		}
		const fill = /fill="([^"]+)"/.exec(attrs)?.[1];
		if (!fill || fill === 'none' || fill === 'rgb(255,255,255)' || fill.startsWith('url(')) continue;
		total += Math.abs(rings.reduce((sum, ring) => sum + signedArea(ring), 0));
	}
	for (const [, w, h] of svg.matchAll(/<rect x="[^"]*" y="[^"]*" width="([\d.]+)" height="([\d.]+)"/g)) {
		total += Number(w) * Number(h);
	}
	return total;
}

/** Our SVG with the background raster removed, so both sides show ink only. */
function inkOnly(svg: string): string {
	return svg.replace(/<image\b[^>]*\/>/g, '');
}

interface PageComparison {
	pageNumber: number;
	deviceSvg: string;
	oursSvg: string;
	deviceInk: number;
	oursInk: number;
}

interface FixtureComparison {
	name: string;
	pages: PageComparison[];
	isolates?: string;
	note?: string;
}

async function buildFixture(noteFile: string): Promise<FixtureComparison | null> {
	const name = noteFile.replace(/\.note$/, '');
	const pdfPath = path.join(INPUT_DIR, `${name}.pdf`);
	try {
		await fs.access(pdfPath);
	} catch {
		return null; // no device export to compare against
	}

	const forms = extractPageForms(await fs.readFile(pdfPath));

	const note = new SupernoteX(new Uint8Array(await fs.readFile(path.join(INPUT_DIR, noteFile))));
	const ours = await toSvg(note, { vectorInk: true, includeText: false });

	// Page n is page n on both sides now, so a count that disagrees is a real
	// finding about the fixture rather than something to quietly paper over.
	if (forms.length !== ours.length) {
		console.warn(`${name}: export has ${forms.length} pages, note has ${ours.length}; comparing the overlap`);
	}

	const pages: PageComparison[] = [];
	for (let i = 0; i < Math.min(forms.length, ours.length); i++) {
		const device = pdfPageToSvg(forms[i], note.pageHeight);
		const oursSvg = inkOnly(ours[i]);
		pages.push({
			pageNumber: i + 1,
			deviceSvg: devicePageToSvgDocument(device, note.pageWidth, note.pageHeight),
			oursSvg,
			deviceInk: device.inkArea,
			oursInk: svgInkArea(oursSvg),
		});
	}

	// An export with no Form XObjects anywhere is either rasterised or a note
	// that genuinely draws nothing, and the file cannot tell those apart --
	// both are just a background image. Our own render decides: ink on our
	// side means the export is raster and there is nothing to compare against,
	// while nothing on either side is the strongest ground truth in the corpus
	// ("the device agrees this page is blank") and worth showing as such.
	if (forms.every((f) => f.length === 0) && pages.some((p) => p.oursInk > 0)) return null;
	const meta = FIXTURE_NOTES[name] ?? {};
	return { name, pages, isolates: meta.isolates, note: meta.note };
}

function ratioLabel(ours: number, device: number): { text: string; tone: 'match' | 'near' | 'off' | 'none' } {
	if (device <= 0 && ours <= 0) return { text: 'no ink either side', tone: 'none' };
	if (device <= 0) return { text: 'device draws nothing', tone: 'off' };
	const ratio = ours / device;
	const text = `${ratio.toFixed(2)}× device ink`;
	if (ratio >= 0.9 && ratio <= 1.1) return { text, tone: 'match' };
	if (ratio >= 0.75 && ratio <= 1.25) return { text, tone: 'near' };
	return { text, tone: 'off' };
}

const STYLE = `:root{
  --ground:#F4F6F7;--surface:#FFFFFF;--ink:#16181C;--muted:#5C6470;--rule:#DDE2E6;
  --accent:#2F6F62;--accent-soft:#E4EFEB;--warn:#8A5A12;--warn-soft:#F7EFE0;
  --shadow:0 1px 2px rgba(22,24,28,.06),0 8px 24px -12px rgba(22,24,28,.18);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#131519;--surface:#1A1D22;--ink:#E8EAED;--muted:#98A0AB;--rule:#2A2F36;
  --accent:#77B9A8;--accent-soft:#1E2C29;--warn:#D6A254;--warn-soft:#2A2317;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px -14px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  --ground:#131519;--surface:#1A1D22;--ink:#E8EAED;--muted:#98A0AB;--rule:#2A2F36;
  --accent:#77B9A8;--accent-soft:#1E2C29;--warn:#D6A254;--warn-soft:#2A2317;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px -14px rgba(0,0,0,.7);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:52px 24px 96px}
a{color:var(--accent)}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-size:clamp(27px,4vw,38px);line-height:1.14;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance;font-weight:640}
.lede{font-size:17px;color:var(--muted);max-width:66ch;margin:0 0 20px}
.top{border-bottom:1px solid var(--rule);padding-bottom:26px}
.meta{display:flex;flex-wrap:wrap;gap:8px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.chip{border:1px solid var(--rule);border-radius:999px;padding:3px 10px;background:var(--surface)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(288px,1fr));gap:14px;margin-top:30px}
.card{display:block;text-decoration:none;color:inherit;background:var(--surface);border:1px solid var(--rule);
  border-radius:12px;padding:16px;box-shadow:var(--shadow)}
.card:hover,.card:focus-visible{border-color:var(--accent)}
.card h2{margin:0 0 6px;font-family:var(--mono);font-size:14px;font-weight:600;letter-spacing:-.01em;word-break:break-all}
.card p{margin:0;font-size:13.5px;color:var(--muted)}
.card .pages{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pill{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;padding:2px 7px;border-radius:999px;border:1px solid var(--rule)}
.pill.match{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.pill.near{background:var(--surface);color:var(--muted)}
.pill.off{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
.pill.none{background:var(--surface);color:var(--muted);border-style:dashed}
.back{font-family:var(--mono);font-size:12px;text-decoration:none;color:var(--muted)}
.back:hover{color:var(--ink)}
.toplinks{display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;font-family:var(--mono);font-size:12px}
.toplinks a{text-decoration:none;border-bottom:1px solid var(--rule);padding-bottom:2px}
.toplinks a:hover,.toplinks a:focus-visible{border-bottom-color:var(--accent)}
.colophon{margin:14px 0 0;font-family:var(--mono);font-size:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.isolates{margin:0;font-size:15.5px;max-width:70ch}
.note{margin:12px 0 0;font-size:14.5px;color:var(--muted);max-width:70ch;border-left:2px solid var(--rule);padding-left:14px}
.pair{margin:22px 0 0;background:var(--surface);border:1px solid var(--rule);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
.pair-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--rule);flex-wrap:wrap}
.pg{font-family:var(--mono);font-size:12px;color:var(--muted)}
.controls{display:flex;gap:4px;align-items:center}
button{font:inherit;cursor:pointer}
.mode{font-family:var(--mono);font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid var(--rule);background:var(--ground);color:var(--muted)}
.mode[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.mode:focus-visible,.flip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.stage{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rule)}
.pane{background:var(--surface);padding:12px;min-width:0;position:relative}
.tag{position:absolute;top:14px;left:14px;z-index:2;font-family:var(--mono);font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted);background:var(--surface);border:1px solid var(--rule);border-radius:5px;padding:2px 7px}
.tag-ours{color:var(--accent);border-color:var(--accent)}
.art{background:#fff;border-radius:6px;overflow:hidden;display:block}
.art svg{display:block;width:100%;height:auto}
.pair[data-mode="blink"] .stage{grid-template-columns:1fr}
.pair[data-mode="blink"] .pane{grid-area:1/1}
.pair[data-mode="blink"][data-show="device"] .pane[data-which="ours"]{visibility:hidden}
.pair[data-mode="blink"][data-show="ours"] .pane[data-which="device"]{visibility:hidden}
.flip{display:block;width:100%;border:0;border-top:1px solid var(--rule);background:var(--ground);color:var(--muted);
  font-family:var(--mono);font-size:12px;padding:9px}
.flip:hover{color:var(--ink)}
footer{margin-top:60px;padding-top:20px;border-top:1px solid var(--rule);color:var(--muted);font-size:13.5px;max-width:74ch}
@media (max-width:760px){.stage{grid-template-columns:1fr}.wrap{padding:34px 16px 72px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

const BLINK_SCRIPT = `for (const pair of document.querySelectorAll('.pair')) {
  const flip = pair.querySelector('.flip');
  for (const b of pair.querySelectorAll('.mode')) {
    b.addEventListener('click', () => {
      pair.dataset.mode = b.dataset.act;
      for (const o of pair.querySelectorAll('.mode')) o.setAttribute('aria-pressed', String(o.dataset.act === b.dataset.act));
      flip.hidden = b.dataset.act !== 'blink';
    });
  }
  flip.addEventListener('click', () => { pair.dataset.show = pair.dataset.show === 'device' ? 'ours' : 'device'; });
}`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="style.css"></head>
<body><div class="wrap">${body}</div><script>${BLINK_SCRIPT}</script></body></html>`;
}

function fixturePage(fx: FixtureComparison): string {
	const pairs = fx.pages
		.map((p) => {
			const r = ratioLabel(p.oursInk, p.deviceInk);
			return `<figure class="pair" data-mode="split" data-show="device">
<figcaption class="pair-head"><span class="pg">page ${p.pageNumber}</span>
<span class="controls"><span class="pill ${r.tone}">${escapeHtml(r.text)}</span>
<button type="button" class="mode" data-act="split" aria-pressed="true">Side by side</button><button type="button" class="mode" data-act="blink" aria-pressed="false">Blink</button></span></figcaption>
<div class="stage">
<div class="pane" data-which="device"><span class="tag">Device</span><div class="art">${p.deviceSvg}</div></div>
<div class="pane" data-which="ours"><span class="tag tag-ours">vectorInk</span><div class="art">${p.oursSvg}</div></div>
</div>
<button type="button" class="flip" hidden>Flip between the two</button>
</figure>`;
		})
		.join('\n');

	return page(
		`${fx.name} — device vs vectorInk`,
		`<a class="back" href="index.html">&larr; all fixtures</a>
<header class="top" style="margin-top:18px">
<p class="eyebrow">fixture</p>
<h1><code style="font-family:var(--mono);font-size:.8em">${escapeHtml(fx.name)}</code></h1>
${fx.isolates ? `<p class="isolates">${escapeHtml(fx.isolates)}</p>` : ''}
${fx.note ? `<p class="note">${escapeHtml(fx.note)}</p>` : ''}
</header>
${pairs}
<footer><p>Both sides are vector ink only. The device's ink comes from the Form XObjects in its own PDF export; ours is <code>toSvg({ vectorInk: true })</code> with the background raster removed, since the device keeps its background in a separate image.</p>
${COLOPHON}</footer>`,
	);
}

function indexPage(fixtures: FixtureComparison[]): string {
	const totalPages = fixtures.reduce((n, f) => n + f.pages.length, 0);
	const cards = fixtures
		.map((f) => {
			const pills = f.pages
				.map((p) => {
					const r = ratioLabel(p.oursInk, p.deviceInk);
					return `<span class="pill ${r.tone}" title="page ${p.pageNumber}: ${escapeHtml(r.text)}">p${p.pageNumber}</span>`;
				})
				.join('');
			return `<a class="card" href="${escapeHtml(slug(f.name))}.html">
<h2>${escapeHtml(f.name)}</h2>
${f.isolates ? `<p>${escapeHtml(f.isolates)}</p>` : '<p>Regression coverage.</p>'}
<div class="pages">${pills}</div></a>`;
		})
		.join('\n');

	return page(
		'Supernote vectorInk — device vs rendered',
		`<header class="top">
<p class="eyebrow">supernote-typescript</p>
<h1>What the device drew, and what we drew</h1>
<p class="lede">Every fixture that ships with Supernote's own PDF export, page by page: the device's vector ink beside the vector ink this library produces. Both sides are real SVG, so differences hold up when you zoom in.</p>
<div class="meta"><span class="chip">${fixtures.length} fixtures</span><span class="chip">${totalPages} pages</span><span class="chip">built from tests/input</span></div>
<nav class="toplinks"><a href="${REPO_URL}">supernote-typescript on GitHub</a><a href="${SPEC_URL}">Vector format spec</a></nav>
</header>
<div class="grid">${cards}</div>
<footer><p>Each page is labelled with the ink it draws as a fraction of the device's — total stroke length times width, plus filled area. It is a blunt measure and only meaningful next to the picture, but it catches a whole stroke going missing, and a tool being drawn at the wrong width. Pages where the device draws no vector ink at all (an entirely erased page) are marked as such rather than scored.</p>
<p>Rebuild with <code>npm run build:site</code>. The <a href="${SPEC_URL}">vector format spec</a> covers how the strokes behind the right-hand panels are decoded.</p>
${COLOPHON}</footer>`,
	);
}

async function main() {
	const noteFiles = (await fs.readdir(INPUT_DIR)).filter((f) => f.endsWith('.note')).sort();
	const built: FixtureComparison[] = [];
	for (const file of noteFiles) {
		const fixture = await buildFixture(file);
		if (fixture && fixture.pages.length > 0) built.push(fixture);
	}
	built.sort((a, b) => {
		const ia = FEATURED.indexOf(a.name), ib = FEATURED.indexOf(b.name);
		if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
		return a.name.localeCompare(b.name);
	});

	await fs.rm(OUT_DIR, { recursive: true, force: true });
	await fs.mkdir(OUT_DIR, { recursive: true });
	await fs.writeFile(path.join(OUT_DIR, 'style.css'), STYLE);
	await fs.writeFile(path.join(OUT_DIR, 'index.html'), indexPage(built));
	// GitHub Pages otherwise runs the output through Jekyll, which skips files
	// and directories beginning with an underscore.
	await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '');
	for (const fixture of built) {
		await fs.writeFile(path.join(OUT_DIR, `${slug(fixture.name)}.html`), fixturePage(fixture));
	}

	const pages = built.reduce((n, f) => n + f.pages.length, 0);
	console.log(`built ${OUT_DIR}/: ${built.length} fixtures, ${pages} page comparisons`);
}

main();
