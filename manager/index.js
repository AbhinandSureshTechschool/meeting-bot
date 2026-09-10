const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const exec = promisify(execFile);
const app = express();

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 4000);
const NETWORK = process.env.DOCKER_NETWORK || 'test-meeting-bot_default';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'test-meeting-bot-meeting-bot';
const CHROME_IMAGE = process.env.CHROME_IMAGE || 'test-meeting-bot-chrome-cdp';

const workers = new Map();
let baseWorkerReserved = false;

async function docker(args) {
  const { stdout } = await exec('docker', args, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    status: response.status,
    data
  };
}

async function isWorkerBusy(workerHost) {
  try {
    const result = await httpJson(`http://${workerHost}:3000/isbusy`);
    return result.status === 200 && Number(result.data?.data) === 1;
  } catch {
    return true;
  }
}

async function waitForWorker(workerHost, timeoutMs = 120000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const result = await httpJson(`http://${workerHost}:3000/health`);

      if (result.status === 200 && result.data?.status === 'healthy') {
        return;
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Worker ${workerHost} did not become ready`);
}

async function createWorker() {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const chromeName = `meeting-bot-chrome-${id}`;
  const workerName = `meeting-bot-worker-${id}`;

  console.log(`Creating temporary Chrome: ${chromeName}`);

  await docker([
    'run',
    '-d',
    '--name', chromeName,
    '--network', NETWORK,
    '--shm-size', '1gb',
    CHROME_IMAGE
  ]);

  console.log(`Creating temporary worker: ${workerName}`);

  await docker([
    'run',
    '-d',
    '--name', workerName,
    '--network', NETWORK,
    '--env-file', '/manager/.env',
    '-e', `GOOGLE_CHROME_CDP_URL=http://${chromeName}:9223`,
    '-e', 'NODE_ENV=development',
    WORKER_IMAGE,
    '/bin/bash',
    './start.sh'
  ]);

  workers.set(workerName, {
    workerName,
    chromeName,
    temporary: true,
    reserved: true
  });

  try {
    await waitForWorker(workerName);
  } catch (error) {
    await removeWorker(workerName);
    throw error;
  }

  console.log(`Temporary worker ready: ${workerName}`);

  return {
    workerName,
    chromeName,
    temporary: true
  };
}

async function removeWorker(workerName) {
  const worker = workers.get(workerName);

  if (!worker) {
    return;
  }

  console.log(`Removing temporary worker: ${worker.workerName}`);

  await docker(['rm', '-f', worker.workerName]).catch(() => {});
  await docker(['rm', '-f', worker.chromeName]).catch(() => {});

  workers.delete(workerName);
}

async function getAvailableWorker() {
  const baseWorker = {
    workerName: 'meeting-bot',
    chromeName: 'chrome-cdp',
    temporary: false
  };

  // Reserve the base worker immediately to prevent two
  // simultaneous requests from selecting it.
  if (!baseWorkerReserved) {
    baseWorkerReserved = true;

    try {
      await waitForWorker(baseWorker.workerName, 15000);

      if (!(await isWorkerBusy(baseWorker.workerName))) {
        return baseWorker;
      }
    } catch {}

    baseWorkerReserved = false;
  }

  // Check existing temporary workers.
  for (const worker of workers.values()) {
    if (worker.reserved) {
      continue;
    }

    worker.reserved = true;

    try {
      if (!(await isWorkerBusy(worker.workerName))) {
        return worker;
      }
    } catch {}

    worker.reserved = false;
  }

  // No available worker → create a new one.
  return createWorker();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    workers: workers.size + 1
  });
});

app.get('/workers', async (req, res) => {
  const result = [];

  result.push({
    workerName: 'meeting-bot',
    temporary: false,
    busy: await isWorkerBusy('meeting-bot')
  });

  for (const worker of workers.values()) {
    result.push({
      workerName: worker.workerName,
      temporary: true,
      busy: await isWorkerBusy(worker.workerName)
    });
  }

  res.json({ success: true, workers: result });
});

app.post('/google/join', async (req, res) => {
  let worker;

  try {
    worker = await getAvailableWorker();

    console.log(`Routing Google Meet request to ${worker.workerName}`);

    const result = await httpJson(
      `http://${worker.workerName}:3000/google/join`,
      {
        method: 'POST',
        body: JSON.stringify(req.body)
      }
    );

    if (result.status >= 400) {
      if (worker.temporary) {
        await removeWorker(worker.workerName);
      }

      return res.status(result.status).json(result.data);
    }

    res.status(result.status).json({
      ...result.data,
      manager: {
        worker: worker.workerName,
        temporary: worker.temporary
      }
    });

    if (worker.temporary) {
      monitorTemporaryWorker(worker).catch(error => {
        console.error(`Temporary worker monitor failed:`, error);
      });
    } else {
  baseWorkerReserved = false;
}
  } catch (error) {
    console.error('Manager join error:', error);

    if (worker?.temporary) {
      await removeWorker(worker.workerName).catch(() => {});
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start meeting bot'
    });
  }
});

async function monitorTemporaryWorker(worker) {
  console.log(`Monitoring ${worker.workerName} for completion`);

  let sawBusy = false;
  const deadline = Date.now() + 4 * 60 * 60 * 1000;

  while (Date.now() < deadline) {
    const busy = await isWorkerBusy(worker.workerName);

    if (busy) {
      sawBusy = true;
    }

    if (sawBusy && !busy) {
      console.log(`${worker.workerName} completed`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      await removeWorker(worker.workerName);
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.error(`${worker.workerName} exceeded monitoring timeout`);
  await removeWorker(worker.workerName);
}

app.listen(PORT, () => {
  console.log(`Meeting Bot Manager running on port ${PORT}`);
});
