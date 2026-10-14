import { assert, describe, it } from "vitest";
import eol from "eol";
import fs from "fs";
import path from "path";
import { fromXml } from "xast-util-from-xml";
import AndroidXmlProcessor from "../src";

const processor = new AndroidXmlProcessor();

const fixtures = ["simple.xml", "strings.xml", "strings-big.xml", "edge.xml"];

function readFixture(filename: string): string {
  return eol.lf(
    fs.readFileSync(path.join("test", "fixtures", filename), {
      encoding: "utf-8",
    }),
  );
}

function textsByKey(input: string): Record<string, string> {
  return Object.fromEntries(
    processor
      .parse(input)
      .segments.map(({ text, metadata }) => [String(metadata?.key), text]),
  );
}

describe("AndroidXmlProcessorTest", function () {
  fixtures.forEach((filename) => {
    it(`should process ${filename} correctly`, function () {
      const input = readFixture(filename);
      const document = processor.parse(input);
      const roundTripped = processor.parse(processor.stringify(document));

      assert.equal(JSON.stringify(roundTripped), JSON.stringify(document));
    });

    it(`should roundtrip ${filename} exactly`, function () {
      const input = readFixture(filename);

      assert.equal(processor.stringify(processor.parse(input)), input);
    });

    it(`should keep ${filename} valid after translation`, function () {
      const input = readFixture(filename);
      const document = processor.parse(input);
      const samples = [
        "Übersetzt 日本語 😀",
        "  leading,   repeated and trailing spaces  ",
        "It's \"quoted\" with back\\slash",
        "multi\nline\ttab",
        "@starts like a reference",
        "?starts like an attribute",
        "<tags> & entities ]]>",
        "control \u0001 char",
      ];
      const expected = new Map<string, string>();

      document.segments.forEach((current, index) => {
        // Keep markers so inline markup is re-rendered too
        const markers = current.text.match(/\{\/?[A-Za-z_][\w:.-]*?\d+\}/g) ?? [];
        current.text = samples[index % samples.length] + markers.join("");
        expected.set(current.id, current.text);
      });

      const output = processor.stringify(document);

      assert.doesNotThrow(() => fromXml(output));

      processor.parse(output).segments.forEach((current) => {
        assert.equal(current.text, expected.get(current.id));
      });
    });
  });

  it("should decode android escapes and whitespace", function () {
    const texts = textsByKey(readFixture("edge.xml"));

    assert.deepInclude(texts, {
      apostrophe: "Don't stop",
      quotes: 'Say "hello"',
      newline: "First line\nSecond line",
      tab: "Name:\tValue",
      backslash: "C:\\Users",
      unicode: "¡Hola!",
      at: "@not_a_reference",
      question: "?not_an_attribute",
      entities: "Save & Restore <state>",
      wrapped: "This text is wrapped over several lines.",
      quoted: "  Keep   these   spaces  ",
      quoted_apostrophe: "It's fine inside quotes",
      escaped_spaces: " Padded ",
      cdata: "<h1>Hello world!</h1>",
    });
  });

  it("should keep inline markup as tags", function () {
    const segments = processor.parse(readFixture("edge.xml")).segments;
    const byKey = (key: string) =>
      segments.find(({ metadata }) => metadata?.key === key);

    assert.equal(byKey("bold")?.text, "Hello {b0}world{/b0}!");
    assert.deepEqual(byKey("font")?.tags, {
      font0: { color: "#ff0000", face: "sans-serif" },
    });
    assert.deepEqual(byKey("placeholder"), {
      ...byKey("placeholder")!,
      text: "Hello {xliff:g0}%1$s{/xliff:g0}!",
      tags: { "xliff:g0": { id: "name", example: "Bob" } },
    });
  });

  it("should resolve keys and skip non-translatable content", function () {
    const keys = Object.keys(textsByKey(readFixture("edge.xml")));

    assert.includeMembers(keys, ["cats.one", "cats.other", "choices..0", "choices..2"]);

    [
      "app_id",
      "reference",
      "empty",
      "blank",
      "self_closing",
      "hidden.one",
      "choices..1",
      "margin",
      "red",
      "count",
    ].forEach((key) => assert.notInclude(keys, key));
  });

  it("should give duplicate names unique ids", function () {
    const segments = processor.parse(readFixture("edge.xml")).segments;
    const variants = segments.filter(({ metadata }) => metadata?.key === "variant");

    assert.lengthOf(variants, 2);
    assert.notEqual(variants[0].id, variants[1].id);
  });

  it("should escape translated text for android", function () {
    const document = processor.parse(
      '<resources><string name="a">Text</string></resources>',
    );

    document.segments[0].text = " It's  <b> & \"x\"\n";

    assert.equal(
      processor.stringify(document),
      '<resources><string name="a">\\u0020It\\\'s \\u0020&lt;b&gt; &amp; \\"x\\"\\n</string></resources>',
    );
  });

  it("should keep cdata when translating", function () {
    const document = processor.parse(
      '<resources><string name="a"><![CDATA[<b>Hi</b>]]></string></resources>',
    );

    document.segments[0].text = "<b>Hallo</b>";

    assert.equal(
      processor.stringify(document),
      '<resources><string name="a"><![CDATA[<b>Hallo</b>]]></string></resources>',
    );
  });

  it("should render translated inline markup", function () {
    const document = processor.parse(
      '<resources><string name="a">Pick <font color="#f00">red</font></string></resources>',
    );

    document.segments[0].text = "Wähle {font0}Rot{/font0}";

    assert.equal(
      processor.stringify(document),
      '<resources><string name="a">Wähle <font color="#f00">Rot</font></string></resources>',
    );
  });

  it("should produce deterministic ids", function () {
    const input = readFixture("edge.xml");

    assert.deepEqual(processor.parse(input), processor.parse(input));
  });
});
