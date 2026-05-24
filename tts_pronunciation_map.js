const pronunciationMap = [
  [/\bnote\b/gi, "nóte"],
  [/\bnotes\b/gi, "nótes"],
  [/\blive\b/gi, "laiv"],
  [/\bstory\b/gi, "historia"],
  [/\bstories\b/gi, "historias"],
  [/\bfeed\b/gi, "perfil"],
  [/\bpost\b/gi, "póst"],
  [/\bposts\b/gi, "pósts"],
  [/\breels\b/gi, "riels"],
  [/\bhack\b/gi, "jack"],
  [/\bhackear\b/gi, "jaquear"],
  [/\bemail\b/gi, "imel"],
  [/\bclick\b/gi, "clik"],
  [/\blink\b/gi, "enlace"],
  [/\bvideo\b/gi, "bideo"],
  [/\bvideos\b/gi, "bideos"],
  [/\bonline\b/gi, "onlain"],
  [/\bfitness\b/gi, "fítnez"],
  [/\bfood\b/gi, "fud"],
  [/\bnatural\b/gi, "naturál"],
];

function normalizeTTS(text) {
  let t = text;
  t = t.normalize("NFC");
  t = t.replace(/[\r\n]+/g, " ");
  t = t.replace(/\s+/g, " ");
  for (const [regex, value] of pronunciationMap) {
    t = t.replace(regex, value);
  }
  t = t
    .replace(/¡/g, "")
    .replace(/!/g, "!")
    .replace(/\?/g, "?")
    .replace(/[:;]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

module.exports = { normalizeTTS };
