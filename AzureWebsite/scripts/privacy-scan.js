const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);
const ignoredContentFiles = new Set([path.resolve(__filename)]);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf']);
const forbiddenNames = [
  /^\.env(?:\..+)?$/,
  /^\.npmrc$/,
  /\.(?:pem|key|p12|pfx|map|db|sqlite|log)$/i,
  /credential|secret/i
];
const contentChecks = [
  ['AWS access key', /A(?:KIA|SIA)[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Azure storage credential', /DefaultEndpointsProtocol=|AccountKey=|SharedAccessSignature=/],
  ['local filesystem path', /\/Users\/|\/home\/|[A-Za-z]:\\Users\\/],
  ['private host reference', /localhost|127\.0\.0\.1|\.internal\b|\.corp\b/i],
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['North American phone number', /(?:\+?1[-. (]*)?(?:[2-9][0-9]{2})[-. )]*[2-9][0-9]{2}[-. ]*[0-9]{4}/]
];

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolutePath, files);
    if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

const findings = [];

for (const file of walk(root)) {
  const relativePath = path.relative(root, file);
  const baseName = path.basename(file);

  if (forbiddenNames.some((pattern) => pattern.test(baseName))) {
    findings.push(`${relativePath}: forbidden filename`);
  }

  if (ignoredContentFiles.has(file) || binaryExtensions.has(path.extname(file).toLowerCase())) continue;

  const content = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of contentChecks) {
    if (pattern.test(content)) findings.push(`${relativePath}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error('Privacy scan failed:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exitCode = 1;
} else {
  console.log('Privacy scan passed. No forbidden files or high-confidence sensitive patterns found.');
}
