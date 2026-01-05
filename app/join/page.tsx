"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const JoinPage = () => {
  const params = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Missing invite token.");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op_name: "project.invite_link_accept", args: { token } }],
      }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok: boolean;
          error?: string;
          results?: Array<{ ok: boolean; error?: string }>;
        };
        if (!payload.ok) {
          throw new Error(payload.error || "Join failed");
        }
        const result = payload.results?.[0];
        if (!result?.ok) {
          throw new Error(result?.error || "Join failed");
        }
        if (!cancelled) {
          setStatus("success");
          setMessage("You have been added to the project.");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const messageText = err instanceof Error ? err.message : "Join failed";
          setStatus("error");
          setMessage(messageText);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main style={{ padding: "24px", fontFamily: "inherit" }}>
      <h1>Project invite</h1>
      {status === "loading" ? <p>Joining project…</p> : null}
      {status === "success" ? <p>{message}</p> : null}
      {status === "error" ? <p>{message ?? "Unable to join."}</p> : null}
      <p>
        <a href="/">Go back to app</a>
      </p>
    </main>
  );
};

export default JoinPage;
