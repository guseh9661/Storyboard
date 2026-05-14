import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'Han.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function stripTags(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function getClass(value, fallback = '') {
  const match = value.match(/class="([^"]*)"/);
  return match ? match[1] : fallback;
}

function getFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? stripTags(match[1]) : '';
}

const sceneStartPattern = /<div class="scene([^"]*)" id="([^"]+)">/g;
const sceneStarts = [...html.matchAll(sceneStartPattern)].map(match => ({
  className: match[1],
  id: match[2],
  start: match.index,
  bodyStart: match.index + match[0].length,
}));

const scenes = sceneStarts.map((sceneStart, index) => {
  const end = sceneStarts[index + 1]?.start ?? html.indexOf('<script>');
  const body = html.slice(sceneStart.bodyStart, end);
  const header = body.match(/<div class="scene-header">([\s\S]*?)<\/div>/);
  const scene = {
    id: sceneStart.id,
    className: `scene${sceneStart.className}`,
    badge: header ? getFirst(header[1], /<span class="scene-badge">([\s\S]*?)<\/span>/) : '',
    title: header ? getFirst(header[1], /<span class="scene-title">([\s\S]*?)<\/span>/) : '',
    description: header ? getFirst(header[1], /<span class="scene-desc">([\s\S]*?)<\/span>/) : '',
    cuts: [],
  };

  const cutStarts = [...body.matchAll(/\n\s*<div class="cut">\s*\n\s*<div class="cut-bar"/g)].map(match => match.index);
  const summaryStart = body.indexOf('<div class="summary-bar">');
  scene.cuts = cutStarts.map((cutStart, cutIndex) => {
    const nextCutStart = cutStarts[cutIndex + 1] ?? (summaryStart >= 0 ? summaryStart : body.length);
    const cutBody = body.slice(cutStart, nextCutStart);
    const cutIdBlock = cutBody.match(/<div class="cut-id([^"]*)">([\s\S]*?)<\/div>/);
    const tagsBlock = cutBody.match(/<div class="cut-tags">([\s\S]*?)<\/div>/);
    const tags = tagsBlock
      ? [...tagsBlock[1].matchAll(/<span class="([^"]+)">([\s\S]*?)<\/span>/g)].map(([, className, text]) => ({
          className,
          text: stripTags(text),
        }))
      : [];

    const detailBlock = cutBody.match(/<div class="detail-grid">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
    const detailCells = detailBlock
      ? [...detailBlock[1].matchAll(/<div class="detail-cell([^"]*)">([\s\S]*?)<\/div>\s*<\/div>/g)].map(([, cellClass, cellBody]) => {
          const textMatch = cellBody.match(/<div class="cell-text([^"]*)"([^>]*)>([\s\S]*?)$/);
          return {
            cellClass: `detail-cell${cellClass}`,
            label: getFirst(cellBody, /<div class="cell-label">([\s\S]*?)<\/div>/),
            textClass: textMatch ? `cell-text${textMatch[1] || ''}` : 'cell-text',
            style: textMatch && textMatch[2] ? (textMatch[2].match(/style="([^"]+)"/) || [])[1] || '' : '',
            text: textMatch ? stripTags(textMatch[3]) : '',
          };
        })
      : [];

    return {
      id: cutIdBlock ? stripTags(cutIdBlock[2]) : '',
      idClass: cutIdBlock ? `cut-id${cutIdBlock[1]}` : 'cut-id',
      tags,
      description: getFirst(cutBody, /<div class="cut-desc">([\s\S]*?)<\/div>/),
      details: detailCells,
    };
  });

  return scene;
});

const data = {
  schemaVersion: 1,
  project: {
    title: '〈한 恨〉 줄콘티',
    updatedAt: new Date().toISOString(),
  },
  scenes,
};

fs.mkdirSync(path.join(root, 'db'), { recursive: true });
fs.writeFileSync(path.join(root, 'db', 'storyboard.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(`Extracted ${scenes.reduce((total, scene) => total + scene.cuts.length, 0)} cuts to db/storyboard.json`);
