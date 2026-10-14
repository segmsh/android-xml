import type { Tag } from "@segmsh/core";
import type { ElementContent, Element as XmlElement, Root as XmlRoot } from "xast";
import { fromXml } from "xast-util-from-xml";

export interface ContentToken {
  start: number;
  end: number;
  raw: string;
  key: string;
}

interface Content {
  text: string;
  tags?: Record<string, Tag>;
}

type MarkupNode =
  | string
  | { name: string; attributes: Tag; children: MarkupNode[]; closed: boolean };

// Placeholder for whitespace that Android collapses and trims
const COLLAPSIBLE = "";

const ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

const MARKER_REGEXP: RegExp = /^(\/?)([A-Za-z_][\w:.-]*?)(\d+)$/;
const LEADING_COLLAPSIBLE_REGEXP: RegExp = new RegExp(
  `^((?:\\{[^}]+\\})*)${COLLAPSIBLE}+`,
);
const TRAILING_COLLAPSIBLE_REGEXP: RegExp = new RegExp(
  `${COLLAPSIBLE}+((?:\\{[^}]+\\})*)$`,
);

// Android resource escaping on top of XML: \' \" \\ \n \t \@ \? \uXXXX, "quoted" runs, collapsed whitespace
const decodeText = (value: string, state: { quoted: boolean }): string => {
  let result = "";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === "\\") {
      const next = value[i + 1];
      if (next === undefined) continue;

      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 2, i + 6))) {
        result += String.fromCharCode(parseInt(value.slice(i + 2, i + 6), 16));
        i += 5;
      } else {
        result += ESCAPES[next] ?? next;
        i++;
      }
    } else if (char === '"') {
      state.quoted = !state.quoted;
    } else if (!state.quoted && /\s/.test(char)) {
      result += COLLAPSIBLE;
    } else {
      result += char;
    }
  }

  return result;
};

const finalizeText = (value: string): string =>
  value
    .replace(new RegExp(`${COLLAPSIBLE}+`, "g"), COLLAPSIBLE)
    .replace(LEADING_COLLAPSIBLE_REGEXP, "$1")
    .replace(TRAILING_COLLAPSIBLE_REGEXP, "$1")
    .replaceAll(COLLAPSIBLE, " ");

export const serialize = (nodes: ElementContent[]): Content => {
  const tags: Record<string, Tag> = {};
  const state = { quoted: false };
  let index = 0;

  const toString = (node: ElementContent): string => {
    if (node.type === "text" || node.type === "cdata") {
      return decodeText(node.value, state);
    }

    if (node.type !== "element") return "";

    const key = `${node.name}${index++}`;
    const attributes = Object.fromEntries(
      Object.entries(node.attributes).map(([name, value]) => [name, String(value ?? "")]),
    );

    if (Object.keys(attributes).length) {
      tags[key] = attributes;
    }

    return `{${key}}${node.children.map(toString).join("")}{/${key}}`;
  };

  const text = finalizeText(nodes.map(toString).join(""));

  return Object.keys(tags).length ? { text, tags } : { text };
};

const parseMarkup = (content: Content): MarkupNode[] => {
  const stack: MarkupNode[] = [];
  const open = new Map<MarkupNode, string>();
  const value = content.text;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      stack.push(buffer);
      buffer = "";
    }
  };

  for (let i = 0; i < value.length; i++) {
    const closingIndex = value[i] === "{" ? value.indexOf("}", i + 1) : -1;
    const marker = closingIndex > 0 ? value.substring(i + 1, closingIndex) : "";
    const match = marker ? MARKER_REGEXP.exec(marker) : null;

    if (!match) {
      buffer += value[i];
      continue;
    }

    flush();

    if (match[1]) {
      const openingIndex = stack.findLastIndex(
        (node) => open.get(node) === marker.slice(1),
      );

      // Unmatched closing marker: drop it and keep the content
      if (openingIndex >= 0) {
        const opening = stack[openingIndex] as Exclude<MarkupNode, string>;
        opening.children = stack.splice(openingIndex + 1);
        opening.closed = true;
        open.delete(opening);
      }
    } else {
      const opening: MarkupNode = {
        name: match[2],
        attributes: content.tags?.[marker] ?? {},
        children: [],
        closed: false,
      };

      open.set(opening, marker);
      stack.push(opening);
    }

    i = closingIndex;
  }

  flush();

  return stack;
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string =>
  escapeXml(value).replace(/"/g, "&quot;");

const encodeText = (
  value: string,
  options: { atStart: boolean; atEnd: boolean; cdata: boolean },
): string => {
  const leadingEnd = options.atStart ? value.length - value.trimStart().length : 0;
  const trailingStart = options.atEnd ? value.trimEnd().length : value.length;
  let result = "";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = value.charCodeAt(i);

    if (char === " ") {
      // Leading, trailing and repeated spaces would be collapsed by Android
      const collapsible = i < leadingEnd || i >= trailingStart || value[i - 1] === " ";
      result += collapsible ? "\\u0020" : " ";
    } else if (char === "\\" || char === "'" || char === '"') {
      result += `\\${char}`;
    } else if (char === "\n") {
      result += "\\n";
    } else if (char === "\t") {
      result += "\\t";
    } else if ((char === "@" || char === "?") && i === 0 && options.atStart) {
      result += `\\${char}`;
    } else if (code < 0x20 || code === 0x7f) {
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      result += char;
    }
  }

  return options.cdata ? result : escapeXml(result);
};

export const render = (content: Content, cdata: boolean): string => {
  const nodes = parseMarkup(content);
  let textCount = 0;
  let textIndex = 0;

  const countTexts = (list: MarkupNode[]) =>
    list.forEach((node) =>
      typeof node === "string" ? textCount++ : countTexts(node.children),
    );

  countTexts(nodes);

  const useCdata = cdata && nodes.length === 1 && typeof nodes[0] === "string" && !content.text.includes("]]>");

  const toXml = (node: MarkupNode): string => {
    if (typeof node === "string") {
      const current = textIndex++;

      return encodeText(node, {
        atStart: current === 0,
        atEnd: current === textCount - 1,
        cdata: useCdata,
      });
    }

    const attributes = Object.entries(node.attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");

    if (!node.closed && !node.children.length) {
      return `<${node.name}${attributes}/>`;
    }

    return `<${node.name}${attributes}>${node.children.map(toXml).join("")}</${node.name}>`;
  };

  const result = nodes.map(toXml).join("");

  return useCdata ? `<![CDATA[${result}]]>` : result;
};

export const parseContent = (raw: string): ElementContent[] => {
  const tree = fromXml(`<root>${raw}</root>`);
  const element = tree.children[0] as XmlElement;

  return element.children;
};

export const isCdata = (nodes: ElementContent[]): boolean => {
  const meaningful = nodes.filter(
    (node) => !(node.type === "text" && !node.value.trim()),
  );

  return meaningful.length === 1 && meaningful[0].type === "cdata";
};

const isTranslatable = (element: XmlElement): boolean =>
  element.attributes.translatable !== "false";

const getRange = (
  source: string,
  element: XmlElement,
  key: string,
): ContentToken | null => {
  const first = element.children[0];
  const last = element.children[element.children.length - 1];
  const start = first?.position?.start.offset;
  const end = last?.position?.end.offset;

  if (start === undefined || end === undefined) return null;

  const raw = source.slice(start, end);

  // Resource references (@string/name, ?attr/name) are not translatable
  if (/^\s*[@?]/.test(raw)) return null;

  return { start, end, raw, key };
};

const childElements = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter(
    (child): child is XmlElement => child.type === "element" && child.name === name,
  );

export const scan = (source: string): ContentToken[] => {
  const tree: XmlRoot = fromXml(source);
  const resources = tree.children.find(
    (child): child is XmlElement => child.type === "element" && child.name === "resources",
  );

  if (!resources) return [];

  const tokens: (ContentToken | null)[] = [];

  resources.children.forEach((child) => {
    if (child.type !== "element" || !isTranslatable(child)) return;

    const name = String(child.attributes.name ?? "");

    if (child.name === "string") {
      tokens.push(getRange(source, child, name));
    } else if (child.name === "plurals") {
      childElements(child, "item").forEach((item) => {
        tokens.push(getRange(source, item, `${name}.${item.attributes.quantity}`));
      });
    } else if (child.name === "string-array") {
      childElements(child, "item").forEach((item, index) => {
        tokens.push(getRange(source, item, `${name}..${index}`));
      });
    }
  });

  return tokens.filter((token): token is ContentToken => token !== null);
};
