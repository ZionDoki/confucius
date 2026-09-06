/* Regex execution is isolated here: the host terminates this worker on timeout. */
/* global self */
self.onmessage = (event) => {
  try {
    const { pattern, subject, maxHits = 20 } = event.data;
    const regex = new RegExp(pattern, "gi");
    const hits = [];
    let match;
    while (hits.length < maxHits && (match = regex.exec(subject))) {
      hits.push({
        index: match.index,
        snippet: subject.slice(
          Math.max(0, match.index - 80),
          Math.min(subject.length, match.index + match[0].length + 120),
        ),
      });
      if (!match[0].length) regex.lastIndex++;
    }
    self.postMessage({ hits });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
