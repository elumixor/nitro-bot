import { botPre } from "@elumixor/nitro-bot";

const ALLOWED_USERS: string[] = [];
const ALLOWED_THREADS: string[] = [];

export default botPre((ctx) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(ctx.user.id)) return false;
  if (ALLOWED_THREADS.length > 0 && !ALLOWED_THREADS.includes(ctx.thread.id)) return false;
});
