export interface AuthUserContext {
  id: string;
  [key: string]: unknown;
}

export interface AppVariables {
  user?: AuthUserContext;
  session?: unknown;
}

export interface AppEnv {
  Variables: AppVariables;
}
