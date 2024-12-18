# Supernote file-format support

This library uses [image-js](https://github.com/image-js/image-js) and can be used inside of browser environments and/or node.

Ratta Supernote has often commented that the file-format is yet unstable and shouldn't be much relied upon (yet). Please keep this in mind.

For some quick snippets, take a look at the [smoke tests](./tests/main.test.ts).

## Developer Notes

### Test Individual Suite

```
npx jest -t 'manta'
```

### Publish

```
npm version patch
npm run build
npm publish
```

## Thank You

- Thank you to [Tiemen Schuijbroek](https://gitlab.com/Tiemen/supernote) for developing the initial supernote Typescript library I forked.
- Heavily inspired by the [Python implementation by jya-dev](https://github.com/jya-dev/supernote-tool). This one currently only supports the X series notebooks.



