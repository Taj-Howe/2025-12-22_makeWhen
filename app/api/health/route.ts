export const runtime = "nodejs";

export const GET = async () => {
  const build = process.env.VERCEL_GIT_COMMIT_SHA ?? new Date().toISOString();
  return Response.json({ ok: true, build });
};
