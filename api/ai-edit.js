const fs = require('node:fs/promises');
const path = require('node:path');

const DB_PATH = 'db/storyboard.json';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function getWriteToken(req) {
  return req.headers['x-storyboard-token'] || req.query?.token || '';
}

function assertWriteAllowed(req) {
  const expected = process.env.STORYBOARD_WRITE_TOKEN;
  if (!expected) return true;
  return getWriteToken(req) === expected;
}

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch };
}

async function githubRequest(config, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`GitHub API failed: ${response.status} ${details}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

async function readDb() {
  const config = githubConfig();
  if (!config) {
    const file = await fs.readFile(path.join(process.cwd(), DB_PATH), 'utf8');
    return { data: JSON.parse(file), config: null, sha: null };
  }

  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${DB_PATH}?ref=${config.branch}`;
  const file = await githubRequest(config, 'GET', url);
  return {
    data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    config,
    sha: file.sha,
  };
}

async function writeDb(data, config, sha, summary) {
  data.project = {
    ...(data.project || {}),
    updatedAt: new Date().toISOString(),
  };

  if (!config) {
    await fs.writeFile(path.join(process.cwd(), DB_PATH), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return;
  }

  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${DB_PATH}`;
  await githubRequest(config, 'PUT', url, {
    branch: config.branch,
    message: `AI storyboard edit: ${summary || 'update cuts'}`,
    content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8').toString('base64'),
    sha,
  });
}

function findCut(data, cutId) {
  for (const scene of data.scenes || []) {
    const index = (scene.cuts || []).findIndex(cut => cut.id === cutId);
    if (index >= 0) return { scene, index };
  }
  return null;
}

function normalizeAiText(text) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseAiJson(text) {
  const normalized = normalizeAiText(text);
  try {
    return JSON.parse(normalized);
  } catch (error) {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(normalized.slice(start, end + 1));
    throw error;
  }
}

function compactStoryboard(data) {
  return {
    project: data.project,
    scenes: (data.scenes || []).map(scene => ({
      id: scene.id,
      title: scene.title,
      description: scene.description,
      cuts: (scene.cuts || []).map(cut => ({
        id: cut.id,
        description: cut.description,
        tags: cut.tags,
        details: cut.details,
      })),
    })),
  };
}

async function callGemini(instruction, data) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.statusCode = 500;
    throw error;
  }

  const prompt = [
    'You are an assistant editing a Korean film storyboard JSON database.',
    'Return only valid JSON. Do not wrap it in markdown.',
    'Use this exact response shape:',
    '{"summary":"short Korean summary","changes":[{"id":"C01","description":"...","tags":[...],"details":[...]}]}',
    'Rules:',
    '- Change only cuts that the user asked to modify or add detail to.',
    '- Preserve the original object shape for every changed cut.',
    '- Do not invent new top-level fields.',
    '- If the request is ambiguous, make the smallest useful edit.',
    '- Korean text should remain natural and production-ready.',
    '',
    `User request: ${instruction}`,
    '',
    `Current storyboard JSON: ${JSON.stringify(compactStoryboard(data))}`,
  ].join('\n');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Gemini API failed: ${response.status} ${details}`);
    error.statusCode = response.status;
    throw error;
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!text) {
    const error = new Error('Gemini returned an empty response');
    error.statusCode = 502;
    throw error;
  }
  return parseAiJson(text);
}

function applyChanges(data, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    const error = new Error('AI did not return any changes');
    error.statusCode = 422;
    throw error;
  }

  const changedIds = [];
  changes.forEach(change => {
    if (!change || !change.id) return;
    const found = findCut(data, change.id);
    if (!found) return;
    found.scene.cuts[found.index] = {
      ...found.scene.cuts[found.index],
      ...change,
    };
    changedIds.push(change.id);
  });

  if (changedIds.length === 0) {
    const error = new Error('AI changes did not match any existing cut IDs');
    error.statusCode = 422;
    throw error;
  }

  return changedIds;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!assertWriteAllowed(req)) {
      return json(res, 401, { error: 'Write token is required' });
    }

    const { instruction } = await readRequestBody(req);
    if (!instruction || !instruction.trim()) {
      return json(res, 400, { error: 'instruction is required' });
    }

    const { data, config, sha } = await readDb();
    const aiResult = await callGemini(instruction.trim(), data);
    const changedIds = applyChanges(data, aiResult.changes);
    await writeDb(data, config, sha, aiResult.summary);

    return json(res, 200, {
      ok: true,
      summary: aiResult.summary || 'AI 수정 완료',
      changedIds,
      data,
    });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || 'Unknown error' });
  }
};
