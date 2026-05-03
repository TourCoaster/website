const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (s: string | null | undefined): string => {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (ch) => HTML_ESC[ch] ?? ch);
};

/** Escape a string for use as a JSON-LD value (still wrapped in JSON.stringify, but
 * the resulting string is then placed inside <script>; close out the script tag. */
export const escapeJsonLd = (obj: unknown): string =>
  JSON.stringify(obj).replace(/<\/script/gi, '<\\/script');
