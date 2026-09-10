const SITE_ORIGIN = 'https://pawchive.pw';

type CreatorTarget = {
  type: 'creator';
  service: string;
  userId: string;
};

type PostTarget = {
  type: 'post';
  service: string;
  userId: string;
  postId: string;
};

export type Target = CreatorTarget | PostTarget;

export function parseTarget(input: string): Target {
  const url = new URL(input);

  if (url.origin !== SITE_ORIGIN || url.username || url.password) {
    throw new Error(`URL must be from ${SITE_ORIGIN}`);
  }

  const pattern = /^\/([\w-]+)\/user\/([\w-]+)(?:\/post\/([\w-]+))?\/?$/;

  const match = url.pathname.match(pattern);

  if (!match) {
    throw new Error('Use post or creator URL.');
  }

  const [, service, userId, postId] = match;

  if (!service || !userId) {
    throw new Error('Service or user ID not found.');
  }

  if (postId) {
    return {
      type: 'post',
      service,
      userId,
      postId,
    };
  }

  return {
    type: 'creator',
    service,
    userId,
  };
}
