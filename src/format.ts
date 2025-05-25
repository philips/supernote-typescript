/** Supernote note object. */
export interface ISupernote {
	/** Page width in pixels. */
	pageWidth: number;
	/** Page height in pixels. */
	pageHeight: number;
	/** Address length in bytes. */
	addressSize: number;
	/** Chunk size descriptor length in bytes. */
	lengthFieldSize: number;
	/** File type signature. */
	signature: string;
	/** Version number in YYYYmmdd e.g. 20230015 */
	version: number;
	/** Default layers. */
	defaultLayers: string[];
	/** Header keyworded data. */
	header: IHeader;
	/** Footer keyworded data. */
	footer: IFooter;
	/** Keywords, text and locations. */
	keywords: Record<string, IKeyword[]>;
	/** Title locations and styles. */
	titles: Record<string, ITitle[]>;
	/** Pages information. */
	pages: IPage[];
	/** Cover page. */
	cover?: ICover;
}

export type IRectangle = [string, string, string, string];

export interface IHeader {
	/** Module label. Usually SNFILE_FEATURE. */
	MODULE_LABEL: string;
	/** File type. Usually NOTE. */
	FILE_TYPE: string;
	/** Device used. E.g. A5X. */
	APPLY_EQUIPMENT: string;
	/** Last opened page. Indexing starts at 1. */
	FINAL_OPERATION_PAGE: string;
	/** Last opened layer. Indexing starts at 1 for usable layers. */
	FINAL_OPERATION_LAYER: string;
	/** Used template for new pages. */
	ORIGINAL_STYLE: string;
	/** Used style hash if affplicable, otherwise 0. */
	ORIGINAL_STYLEMD5: string;
	/** Device DPI. Currently unused (0). */
	DEVICE_DPI: string;
	/** Software DPI. Currently unused (0). */
	SOFT_DPI: string;
	/** File parsing type. Currently unused (0). */
	FILE_PARSE_TYPE: string;
	/** Ratta ETMD. Currently unused (0). */
	RATTA_ETMD: string;
	/** Supernote app version. Currently unused (0). */
	APP_VERSION: string;
	/** Handwriting recognition and text enabled */
	FILE_RECOGN_TYPE: string;
}

export interface IKeyword {
	/** Keyword sequence number. */
	KEYWORDSEQNO: string;
	/** Keyword page number. Indexing starts at 1. */
	KEYWORDPAGE: string;
	/** Keyword rectangle coordinates. */
	KEYWORDRECT: IRectangle;
	/** Keyword rectangle coordinates (original?). */
	KEYWORDRECTORI: IRectangle;
	/** Keyword site. */
	KEYWORDSITE: string;
	/** Keyword word length */
	KEYWORDLEN: string;
	/** Keyword word. */
	KEYWORD: string;
	/** Keyword bitmap content. */
	bitmapBuffer: Uint8Array | null;
}

export interface ITitle {
	/** Title sequence number. */
	TITLESEQNO: string;
	/** Title level number. Indexing starts at 1. */
	TITLELEVEL: string;
	/** Title rectangle coordinates. */
	TITLERECT: IRectangle;
	/** Title rectangle coordinates (original?). */
	TITLERECTORI: IRectangle;
	/** Title bitmap. */
	TITLEBITMAP: string;
	/** Title protocol. Usually RATTA_RLE. */
	TITLEPROTOCOL: string;
	/** Title style. */
	TITLESTYLE: string;
	/** Title bitmap content. */
	bitmapBuffer: Uint8Array | null;
}

export type ILayerNames =
	| 'MAINLAYER'
	| 'LAYER1'
	| 'LAYER2'
	| 'LAYER3'
	| 'BGLAYER';

export interface ILayer {
	/** Layer type. Usually NOTE. */
	LAYERTYPE: string;
	/** Layer protocol. Usually RATTA_RLE. */
	LAYERPROTOCOL: string;
	/** Layer name. */
	LAYERNAME: ILayerNames;
	/** Layer path. */
	LAYERPATH: string;
	/** Layer bitmap address. */
	LAYERBITMAP: string;
	/** Layer vector graph. */
	LAYERVECTORGRAPH: string;
	/** Layer recognition. */
	LAYERRECOGN: string;
	/** Layer bitmap content. */
	bitmapBuffer: Uint8Array | null;
}

export enum RecognitionStatuses {
	NONE = '0',
	DONE = '1',
	RUNNING = '2',
}

export interface IRecognitionElement {
	label: string;
	type: string;
	words: {
		label: string;
		"bounding-box"?: {
			height: number;
			width: number;
			x: number;
			y: number;
		};
	}[];
}

export interface IPage {
	/** Page style (template). */
	PAGESTYLE: string;
	/** Page style MD5. */
	PAGESTYLEMD5: string;
	/** Layer switch. */
	LAYERSWITCH: string;
	/** Main layer contents. */
	MAINLAYER: ILayer;
	/** Layer 1 contents. */
	LAYER1: ILayer;
	/** Layer 2 contents. */
	LAYER2: ILayer;
	/** Layer 3 contents. */
	LAYER3: ILayer;
	/** Background layer contents. */
	BGLAYER: ILayer;
	/** Layer information. */
	LAYERINFO: ILayerInfo[];
	/** Layer sequence (names). */
	LAYERSEQ: ILayerNames[];
	/** Total path size. */
	TOTALPATH: string;
	/** Layer thumbnail type. */
	THUMBNAILTYPE: string;
	/** Status of text recognition */
	RECOGNSTATUS: RecognitionStatuses;
	/** Address of recognition text */
	RECOGNTEXT: string;
	/** Address of recognition file */
	RECOGNFILE: string;
	/** Status of text recognition */
	RECOGNFILESTATUS: RecognitionStatuses;
	/** An indicator of device and file orientation */
	ORIENTATION: string;
	/** Parsed elements from recognition */
	recognitionElements: IRecognitionElement[];
	/** Parsed paragraphs from recognition */
	paragraphs: string;
	/** Parsed text from recognition */
	text: string;
	/** Total path contents. */
	totalPathBuffer: Uint8Array | null;
}



export interface ILayerInfo {
	/** Layer ID number. -1 (background), 0 (main) ... 3 (layer3) */
	layerId: number;
	/** Display names for the layer. */
	name: string;
	/** Whether this is the background layer. */
	isBackgroundLayer: boolean;
	/** Allowed to draw on this layer? */
	isAllowAdd: boolean;
	/** Is this the current editing layer? */
	isCurrentLayer: boolean;
	/** Whether this layer is currently visible. */
	isVisible: boolean;
	/** Whether this layer is currently deleted. */
	isDeleted: boolean;
	/** Whether this layer is allowed to be moved up. */
	isAllowUp: boolean;
	/** Whether this layer is allowed to be moved down. */
	isAllowDown: boolean;
}

export interface IFooter {
	/** File-feature (header address). */
	FILE: Record<string, string>;
	/** Cover values. Mappings of COVER_{key}:value. Mostly 0:0 and 1:N. */
	COVER: Record<string, string>;
	/** Keyword values. Mappings of KEYWORD_{key}:{value}. */
	KEYWORD: Record<string, string | string[]>;
	/** Title values. Mappings of TITLE_{key}:{value}. */
	TITLE: Record<string, string | string[]>;
	/** Style values. Mappings of STYLE_{key}:{value}. */
	STYLE: Record<string, string>;
	/** Page values. Mappings of PAGE{key}:{value}. */
	PAGE: Record<string, string>;
}

export type ICover = {
	/** Cover bitmap content. */
	bitmapBuffer: Uint8Array | null;
};
