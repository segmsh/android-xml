# @segmsh/android-xml

Android XML processor for [segm.sh](https://segm.sh). This package parses Android string resources (`res/values/strings.xml`) into a document (AST + segments) and stringifies them back, treating string content as translatable segments while leaving everything else byte-for-byte intact.

## Installation

```bash
npm install @segmsh/android-xml
```

## Usage

```typescript
import AndroidXmlProcessor from "@segmsh/android-xml";

const processor = new AndroidXmlProcessor();

const content = `<resources>
    <string name="welcome">Don\\'t miss <b>this</b>!</string>
</resources>`;
const document = processor.parse(content);
// document.segments[0].text === "Don't miss {b0}this{/b0}!"
// document.segments[0].metadata === { key: "welcome" }

// ... modify document segments ...

const newContent = processor.stringify(document);
```

## Features

- **Source Preservation**: Comments, formatting, attributes and non-string resources are kept exactly as written.
- **Resource Types**: `<string>`, `<plurals>` items and `<string-array>` items are segmented; `translatable="false"` and `@string/…` references are skipped.
- **Android Escaping**: Segments contain the text as the app shows it (`\'`, `\"`, `\n`, `\uXXXX`, quoted runs and whitespace collapsing are decoded); translated text is escaped back.
- **Inline Markup**: Elements such as `<b>`, `<font>` and `<xliff:g>` become `{tagN}...{/tagN}` markers with their attributes in `tags`. CDATA content stays in CDATA.
- **Key Paths**: Each segment carries its resource name in `metadata.key` (`name`, `plural.one`, `array..0`).
- **Round-trip**: Parsing and stringifying an unchanged document returns the original input.

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

## License

[Apache-2.0](LICENSE)
