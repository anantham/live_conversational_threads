const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const backendPort = process.env.BACKEND_PORT || '43180';
const frontendPort = process.env.FRONTEND_PORT || '43173';
const pythonPath =
  process.platform === 'win32'
    ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
    : path.join(rootDir, '.venv', 'bin', 'python3');

function writePortFiles() {
  fs.writeFileSync(path.join(rootDir, '.backend-port'), `${backendPort}\n`);
  fs.writeFileSync(path.join(rootDir, '.frontend-port'), `${frontendPort}\n`);
}

function spawnChecked(command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  child.on('error', (error) => {
    console.error(`[dev] Failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  return child;
}

writePortFiles();
console.log(`[dev] Starting local stack with backend=${backendPort} frontend=${frontendPort}`);

const frontendCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const frontend = spawnChecked(
  frontendCommand,
  ['--prefix', 'lct_app', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', frontendPort, '--strictPort'],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      FRONTEND_PORT: frontendPort,
      VITE_BACKEND_PORT: backendPort,
      VITE_BACKEND_API_URL: `http://localhost:${backendPort}`,
    },
  }
);

const backend = spawnChecked(
  pythonPath,
  ['-m', 'uvicorn', 'lct_python_backend.backend:lct_app', '--reload', '--host', '0.0.0.0', '--port', backendPort],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      BACKEND_PORT: backendPort,
      FRONTEND_PORT: frontendPort,
      FRONTEND_URL: process.env.FRONTEND_URL || `http://localhost:${frontendPort}`,
      PYTHONPATH: [rootDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  }
);

function shutdown(signal) {
  for (const child of [frontend, backend]) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

let exited = 0;
for (const child of [frontend, backend]) {
  child.on('exit', (code) => {
    exited += 1;
    if (code && process.exitCode === undefined) {
      process.exitCode = code;
    }
    if (exited === 1) {
      shutdown('SIGTERM');
    }
    if (exited === 2) {
      process.exit(process.exitCode || 0);
    }
  });
}
