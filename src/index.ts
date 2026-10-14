import {
  Document,
  Element,
  Processor,
  Root,
  Segment,
  id,
  root,
  segment,
  text,
} from "@segmsh/core";
import { isCdata, parseContent, render, scan, serialize } from "./utils.js";

export default class AndroidXmlProcessor implements Processor {
  parse(res: string): Document {
    const children: Root["children"] = [];
    const segments: Segment[] = [];
    const occurrences = new Map<string, number>();
    let position = 0;

    scan(res).forEach((token) => {
      const content = serialize(parseContent(token.raw));

      if (!content.text.trim()) return;

      if (token.start > position) {
        children.push(text(res.slice(position, token.start)));
      }

      // Duplicate names are allowed (e.g. product variants), ids must stay unique
      const occurrence = occurrences.get(token.key) ?? 0;
      occurrences.set(token.key, occurrence + 1);

      const segId = id(occurrence ? `${token.key}\u0000${occurrence}` : token.key);

      segments.push({
        id: segId,
        ...content,
        metadata: { key: token.key },
      });

      children.push({
        type: "element",
        tagName: "value",
        properties: { raw: token.raw },
        children: [segment(segId)],
      });

      position = token.end;
    });

    if (position < res.length) {
      children.push(text(res.slice(position)));
    }

    return { tree: root(children), segments };
  }

  stringify(document: Document): string {
    const segmentsMap = new Map<string, Segment>(
      document.segments.map((current) => [current.id, current]),
    );

    return document.tree.children
      .map((child) => {
        if (child.type === "text") return child.value;
        if (child.type !== "element") return "";

        const raw = String((child as Element).properties.raw);
        const ref = child.children[0];
        const current =
          ref?.type === "segment" ? segmentsMap.get(ref.id) : undefined;

        if (!current) return raw;

        const nodes = parseContent(raw);
        const original = serialize(nodes);

        // Unchanged content keeps its original markup, escapes and whitespace
        if (
          original.text === current.text &&
          JSON.stringify(original.tags) === JSON.stringify(current.tags)
        ) {
          return raw;
        }

        return render(current, isCdata(nodes));
      })
      .join("");
  }
}
