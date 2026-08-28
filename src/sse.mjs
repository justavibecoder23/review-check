export function encodeSseEvent(event, data) {
  const payload = JSON.stringify(data ?? null);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function createProgressReporter(report) {
  if (typeof report !== 'function') return () => {};
  return (stage, percent, message, details) => {
    try {
      report({
        stage,
        percent: Math.min(100, Math.max(0, Number(percent) || 0)),
        message,
        ...(details === undefined ? {} : { details })
      });
    } catch {
      // Việc cập nhật giao diện không được phép làm hỏng tiến trình phân tích.
    }
  };
}

export function openSse(response) {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  response.once('close', () => { closed = true; });
  return {
    send(event, data) {
      if (closed || response.destroyed || response.writableEnded) return false;
      response.write(encodeSseEvent(event, data));
      response.flush?.();
      return true;
    },
    close() {
      if (!closed && !response.destroyed && !response.writableEnded) response.end();
      closed = true;
    }
  };
}
