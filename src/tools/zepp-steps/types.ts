export type ZeppTokens = {
  accessToken?: string;
  loginToken?: string;
  appToken?: string;
  userId?: string;
  deviceId?: string;
  boundDeviceId?: string;
  accessTokenTime?: string;
  loginTokenTime?: string;
  appTokenTime?: string;
};

export type ZeppLastRun = {
  at: string;
  ok: boolean;
  step: number | null;
  message: string;
};

export type ZeppAccount = {
  id: string;
  user: string;
  password: string;
  enabled: boolean;
  tokens: ZeppTokens;
  lastRun: ZeppLastRun | null;
};

export type ZeppStepsFile = {
  minStep: number;
  maxStep: number;
  accounts: ZeppAccount[];
};

export type ZeppAccountPublic = {
  id: string;
  user: string;
  userMasked: string;
  enabled: boolean;
  hasPassword: boolean;
  lastRun: ZeppLastRun | null;
};

export type ZeppStepsPublic = {
  minStep: number;
  maxStep: number;
  accounts: ZeppAccountPublic[];
};
