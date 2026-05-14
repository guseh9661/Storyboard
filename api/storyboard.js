const fs = require('node:fs/promises');
const path = require('node:path');

const DB_PATH = 'db/storyboard.json';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function getWriteToken(req) {
  return req.headers['x-storyboard-token'] || req.query?.token || '';
}

function assertWriteAllowed(req) {
  const expected = process.env.STORYBOARD_WRITE_TOKEN;
  if (!expected) return true;
  return getWriteToken(req) === expected;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function findCut(data, cutId) {
  for (const scene of data.scenes || []) {
    const index = (scene.cuts || []).findIndex(cut => cut.id === cutId);
    if (index >= 0) return { scene, index };
  }
  return null;
}

function mergeCut(data, incomingCut) {
  if (!incomingCut || !incomingCut.id) {
    const error = new Error('cut.id is required');
    error.statusCode = 400;
    throw error;
  }

  const found = findCut(data, incomingCut.id);
  if (!found) {
    const error = new Error(`Cut ${incomingCut.id} was not found`);
    error.statusCode = 404;
    throw error;
  }

  found.scene.cuts[found.index] = {
    ...found.scene.cuts[found.index],
    ...incomingCut,
  };
  data.project = {
    ...(data.project || {}),
    updatedAt: new Date().toISOString(),
  };
  return data;
}

async function readLocalDb() {
  const file = await fs.readFile(path.join(process.cwd(), DB_PATH), 'utf8');
  return JSON.parse(file);
}

async function writeLocalDb(data) {
  await fs.writeFile(path.join(process.cwd(), DB_PATH), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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

async function readGithubDb(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${DB_PATH}?ref=${config.branch}`;
  const file = await githubRequest(config, 'GET', url);
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}

async function writeGithubDb(config, data, cutId) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${DB_PATH}`;
  const current = await githubRequest(config, 'GET', `${url}?ref=${config.branch}`);
  await githubRequest(config, 'PUT', url, {
    branch: config.branch,
    message: `Update storyboard ${cutId}`,
    content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8').toString('base64'),
    sha: current.sha,
  });
}

module.exports = async function handler(req, res) {
  try {
    const config = githubConfig();

    if (req.method === 'GET') {
      const data = config ? await readGithubDb(config) : await readLocalDb();
      return json(res, 200, data);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!assertWriteAllowed(req)) {
      return json(res, 401, { error: 'Write token is required' });
    }

    const payload = await readRequestBody(req);
    const data = config ? await readGithubDb(config) : await readLocalDb();
    const nextData = mergeCut(data, payload.cut);

    if (config) {
      await writeGithubDb(config, nextData, payload.cut.id);
    } else {
      await writeLocalDb(nextData);
    }

    return json(res, 200, { ok: true, cutId: payload.cut.id, updatedAt: nextData.project.updatedAt });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || 'Unknown error' });
  }
};
