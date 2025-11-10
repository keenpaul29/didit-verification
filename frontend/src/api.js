const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api/v1/verification';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const VerificationAPI = {
  createSession(payload) {
    return request('/session/create', { method: 'POST', body: JSON.stringify(payload) });
  },
  getStatus(userId) {
    return request(`/status/${userId}`, { method: 'GET' });
  },
  sendPhoneCode(phoneNumber, userId) {
    return request('/phone/send', { method: 'POST', body: JSON.stringify({ phoneNumber, userId }) });
  },
  checkPhoneCode({ code, phoneNumber }) {
    return request('/phone/check', { method: 'POST', body: JSON.stringify({ code, phoneNumber }) });
  },
  verifyId({ userId, frontImage, backImage, documentType }) {
    return request('/id/verify', { method: 'POST', body: JSON.stringify({ userId, frontImage, backImage, documentType }) });
  },
};

export function generateUUIDv4() {
  return crypto.randomUUID();
}
