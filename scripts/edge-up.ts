import { launchEdge } from '../src/browser/edge.js';
await launchEdge({ debugPort: 9223, userDataDir: '.runtime/edge-profile-deepseek', startUrl: 'https://chat.deepseek.com/' });
console.log('edge up');
process.exit(0);
