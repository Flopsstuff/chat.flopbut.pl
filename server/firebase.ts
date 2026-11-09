import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { config } from './config.js';

// On Cloud Run the runtime service account's default credentials are used; no key files.
export const app =
  getApps()[0] ?? initializeApp({ projectId: config.projectId, databaseURL: config.databaseURL });

export const auth = getAuth(app);
export const db = getDatabase(app);
