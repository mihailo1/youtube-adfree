const VISITOR_DATA_PATTERNS = [
  /"VISITOR_DATA"\s*:\s*"([^"]+)"/,
  /"visitorData"\s*:\s*"([^"]+)"/
] as const;

export function extractVisitorData(html: string): string | null {
  for (const pattern of VISITOR_DATA_PATTERNS) {
    const match = html.match(pattern);
    const value = match?.[1];
    if (value) {
      return value;
    }
  }
  return null;
}

export function extractVisitorDataFromDocument(doc: Document = document): string | null {
  const scripts = doc.querySelectorAll("script");
  for (const elScript of scripts) {
    const text = elScript.textContent;
    if (!text) {
      continue;
    }

    const value = extractVisitorData(text);
    if (value) {
      return value;
    }
  }

  return extractVisitorData(doc.documentElement?.innerHTML ?? "");
}
