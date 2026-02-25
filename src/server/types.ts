export interface AppUser {
  id: string;
  email?: string;
  name?: string;
}

export interface AppSession {
  id: string;
  userId?: string;
  token?: string;
}

export interface AppVariables {
  user: AppUser;
  session: AppSession;
}
