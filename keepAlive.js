import fetch from 'node-fetch';

setInterval(() => {
  fetch('https://seu-bot-no-render.onrender.com').catch(() => {});
}, 1000 * 60 * 10);
