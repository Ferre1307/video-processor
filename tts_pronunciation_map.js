const pronunciationMap = [
  // inglés social media
  [/\bnote\b/gi, "nóte"],
  [/\bnotes\b/gi, "nótes"],
  [/\blive\b/gi, "laiv"],
  [/\bstory\b/gi, "historia"],
  [/\bstories\b/gi, "historias"],
  [/\bfeed\b/gi, "perfil"],
  [/\bpost\b/gi, "póst"],
  [/\bposts\b/gi, "pósts"],
  [/\breels\b/gi, "riels"],
  [/\bemail\b/gi, "imel"],
  [/\bclick\b/gi, "clik"],
  [/\blink\b/gi, "enlace"],
  [/\bonline\b/gi, "onlain"],
  [/\bfitness\b/gi, "fítnez"],
  [/\bfood\b/gi, "fud"],
  [/\bhackear\b/gi, "jaquear"],
  [/\bupdate\b/gi, "apdéit"],
  [/\bweek\b/gi, "uik"],
  [/\btips\b/gi, "tips"],
  [/\btrend(s)?\b/gi, "trend"],
  [/\bvideo\b/gi, "bideo"],
  [/\bvideos\b/gi, "bideos"],
  [/\bnatural\b/gi, "naturál"],
];

function normalizeTTS(text) {
  let t = text;

  // 1. normalización base
  t = t.normalize("NFC");
  t = t.replace(/[\r\n]+/g, " ");
  t = t.replace(/\s+/g, " ");

  // 2. forzar contexto español
  t = " " + t + " ";

  // 3. aplicar mapa
  for (const [regex, value] of pronunciationMap) {
    t = t.replace(regex, value);
  }

  // 4. limpieza final
  t = t
    .replace(/¡/g, "")
    .replace(/[:;]/g, ",")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}

module.exports = { normalizeTTS };
