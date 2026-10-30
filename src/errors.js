'use strict';

// An error that carries the HTTP status and a message that is safe to show to visitors.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
