// Built-in TURN relays used by everyone who opens this deployment.
//
// Direct P2P works on most networks, but some (mobile data / carrier NAT,
// office firewalls) block it. A TURN relay forwards the already-encrypted
// audio packets; it cannot decrypt them. Only ONE side of a call needs a
// working TURN server for the call to connect.
//
// Free options (sign up, then paste the credentials they give you):
//   ExpressTURN  https://www.expressturn.com
//   Metered      https://www.metered.ca/tools/openrelay/
//
// Example:
// export const TURN_SERVERS = [
//   { urls: ['turn:YOUR.HOST:3478', 'turn:YOUR.HOST:443?transport=tcp', 'turns:YOUR.HOST:443?transport=tcp'],
//     username: 'YOUR_USERNAME', credential: 'YOUR_PASSWORD' },
// ];
//
// Note: these values are visible to anyone who opens the site.

export const TURN_SERVERS = [
  {
    // ExpressTURN free tier
    urls: ['turn:free.expressturn.com:3478', 'turn:free.expressturn.com:3478?transport=tcp'],
    username: '000000002108416451',
    credential: 'S+jElkRZROQGhgGhBJ8vTY+Y2Mk=',
  },
];
