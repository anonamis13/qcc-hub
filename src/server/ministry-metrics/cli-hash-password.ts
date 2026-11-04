import { hashPassword } from './auth.js';

/**
 * Generates the value for METRICS_PASSWORD_HASH.
 *
 *   node dist/server/ministry-metrics/cli-hash-password.js "your password"
 */
const password = process.argv[2];

if (!password) {
  console.error('Usage: cli-hash-password "<password>"');
  console.error('Wrap the password in quotes if it contains spaces.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Choose a password of at least 8 characters.');
  process.exit(1);
}

console.log('\nAdd this line to your .env file and to the Render environment settings:\n');
console.log(`METRICS_PASSWORD_HASH=${hashPassword(password)}\n`);
console.log('The password itself is not stored anywhere. Changing it signs everyone out.\n');
