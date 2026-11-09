import { describe, expect, it } from 'vitest';
import { publicImageUrl } from '../web/src/imageHosts.js';

describe('publicImageUrl', () => {
  it('lets through public files of the repositories and the sites', () => {
    for (const url of [
      'https://raw.githubusercontent.com/Flopsstuff/keryx/v1.0.0/docs/speaker.jpg',
      'https://github.com/Flopsstuff/keryx/raw/main/docs/speaker.jpg',
      'https://media.githubusercontent.com/media/Flopsstuff/aimaf/83b8d03/1.png',
      'https://flopbut.pl/images/coin.webp',
      'https://stuff.flopbut.pl/shots/triki.png',
    ]) {
      expect(publicImageUrl(url)).toBe(url);
    }
  });

  it('keeps out everything else', () => {
    for (const url of [
      'http://raw.githubusercontent.com/Flopsstuff/keryx/main/a.jpg',
      'https://github.com/Flopsstuff/keryx/blob/main/a.jpg',
      'https://private-user-images.githubusercontent.com/1/a.png?jwt=x',
      'https://img.shields.io/badge/x-y-green.svg',
      'https://flopbut.pl.evil.com/a.jpg',
      'https://user:pass@flopbut.pl/a.jpg',
      'https://flopbut.pl:8443/a.jpg',
      'javascript:alert(1)',
      'photos/keryx/a.jpg',
    ]) {
      expect(publicImageUrl(url)).toBeNull();
    }
  });
});
