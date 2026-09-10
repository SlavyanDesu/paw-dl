import figlet from 'figlet';

let cachedBanner: string | null = null;

export function getBanner(): string {
  if (cachedBanner) {
    return cachedBanner;
  }

  cachedBanner = figlet.textSync('paw-dl', {
    font: 'Small',
    horizontalLayout: 'default',
    verticalLayout: 'default',
  });

  return cachedBanner;
}
