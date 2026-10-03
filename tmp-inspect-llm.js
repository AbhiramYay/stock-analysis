const fs = require('fs');
const data = JSON.parse(fs.readFileSync('llm-output/llm-failure-batch-1782064539654.json', 'utf8'));
const s = data.extractedJson;
function sanitizeJsonText(jsonText) {
  let cleaned = jsonText
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/([\{,])\s*([^"\s][^:\n\r]+?)\s*:/g, '$1"$2":');
  cleaned = cleaned.replace(/:\s*'([^']*)'/g, ': "$1"');
  cleaned = cleaned.replace(/\b(true|false|null)\b/gi, (match) => match.toLowerCase());

  return cleaned;
}

const cleaned = sanitizeJsonText(s);
console.log('parsed?', (() => { try { JSON.parse(cleaned); return 'ok'; } catch (e) { return e.message; } })());
console.log('length', cleaned.length);
console.log('snippet', cleaned.slice(300, 380));
console.log('pos 323 char', cleaned[323]);
console.log('parse pos around 320', cleaned.slice(300, 340));
