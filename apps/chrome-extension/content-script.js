function extractIdentifiers() {
  const text = document.body ? document.body.innerText : "";
  const doi =
    (text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i) || [])[0] ||
    document.querySelector('meta[name="citation_doi"]')?.content;
  const arxiv =
    (location.hostname.includes("arxiv.org") &&
      (location.pathname.match(/\/(\d{4}\.\d{4,5})(?:v\d+)?/) || [])[1]) ||
    (text.match(/\barXiv:(\d{4}\.\d{4,5})/i) || [])[1];
  const pmid =
    (location.hostname.includes("pubmed") &&
      (location.pathname.match(/\/(\d{5,})/) || [])[1]) ||
    document.querySelector('meta[name="citation_pmid"]')?.content;
  const pdfLink = document.querySelector('a[href$=".pdf"]')?.href;
  return {
    tabId: 0,
    url: location.href,
    title: document.title,
    identifiers: {
      doi: doi || undefined,
      arxiv: arxiv || undefined,
      pmid: pmid || undefined,
      pdfUrl: pdfLink || (location.href.endsWith(".pdf") ? location.href : undefined),
    },
    readableText: text.slice(0, 4000),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "confucius.extract") {
    sendResponse(extractIdentifiers());
  }
  return true;
});
