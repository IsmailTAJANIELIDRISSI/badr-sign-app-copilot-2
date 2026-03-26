export const state = {
  ltaFiles: [],
  jobs: new Map(),
};

export const createJob = (id) => {
  const job = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    progress: {
      total: 0,
      done: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    },
    logs: [],
    results: [],
  };
  state.jobs.set(id, job);
  return job;
};

export const pushJobLog = (jobId, level, message, meta = {}) => {
  const job = state.jobs.get(jobId);
  if (!job) return;
  job.logs.push({
    at: new Date().toISOString(),
    level,
    message,
    meta,
  });
  if (job.logs.length > 1000) {
    job.logs = job.logs.slice(-1000);
  }
};
