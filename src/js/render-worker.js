// Background renderer: computes one note's samples from its formula (same code as the main thread).
import { renderJob } from './synth.js';

self.onmessage = ({ data: job }) => {
  try {
    const out = renderJob(job);
    self.postMessage({ id: job.id, data: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err?.message || err) });
  }
};
