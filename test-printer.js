const net = require('net');
const socket = new net.Socket();
socket.setTimeout(5000);
socket.once('connect', () => {
  console.log('Connected!');
  socket.destroy();
});
socket.once('timeout', () => {
  console.log('Timeout');
  socket.destroy();
});
socket.once('error', (err) => {
  console.log(' Error:', err.message);
  socket.destroy();
});
socket.connect(9100, '192.168.1.26');
