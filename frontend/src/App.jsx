import { useMemo, useState } from 'react';
import './App.css';
import { VerificationAPI, generateUUIDv4 } from './api';

function App() {
  const [userId, setUserId] = useState('');
  const effectiveUserId = useMemo(() => userId?.trim() || generateUUIDv4(), [userId]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [apiResponse, setApiResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [frontFile, setFrontFile] = useState(null);
  const [backFile, setBackFile] = useState(null);
  const [documentType, setDocumentType] = useState('');

  async function createSession() {
    setBusy(true);
    setMessage('Creating session...');
    try {
      const res = await VerificationAPI.createSession({ userId: effectiveUserId });
      setApiResponse(res);
      setMessage('Session created');
      setUserId(effectiveUserId);
      if (res?.data?.verification_url) window.open(res.data.verification_url, '_blank');
    } catch (e) {
      setApiResponse(e.data || { error: e.message });
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    if (!userId.trim()) {
      setMessage('Enter User ID');
      return;
    }
    setBusy(true);
    setMessage('Checking status...');
    try {
      const res = await VerificationAPI.getStatus(userId.trim());
      setApiResponse(res);
      setMessage('Status retrieved');
    } catch (e) {
      setApiResponse(e.data || { error: e.message });
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendPhone() {
    if (!phoneNumber.trim()) {
      setMessage('Enter phone number in E.164 format');
      return;
    }
    setBusy(true);
    setMessage('Sending code...');
    try {
      const res = await VerificationAPI.sendPhoneCode(phoneNumber.trim(), effectiveUserId);
      setApiResponse(res);
      setMessage('Code sent');
      setUserId(effectiveUserId);
      setRequestId(res?.data?.request_id || '');
    } catch (e) {
      setApiResponse(e.data || { error: e.message });
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function checkPhone() {
    if (!requestId.trim() || !code.trim()) {
      setMessage('Provide requestId and code');
      return;
    }
    setBusy(true);
    setMessage('Verifying code...');
    try {
      const res = await VerificationAPI.checkPhoneCode({ requestId: requestId.trim(), code: code.trim(), userId: effectiveUserId, phoneNumber: phoneNumber.trim() });
      setApiResponse(res);
      setMessage(res?.data?.valid ? 'Phone verified' : 'Invalid code');
      setUserId(effectiveUserId);
    } catch (e) {
      setApiResponse(e.data || { error: e.message });
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function clearAll() {
    setUserId('');
    setPhoneNumber('');
    setRequestId('');
    setCode('');
    setFrontFile(null);
    setBackFile(null);
    setDocumentType('');
    setApiResponse(null);
    setMessage('');
  }

  async function fileToBase64(file) {
    if (!file) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function verifyId() {
    if (!frontFile) {
      setMessage('Upload front image to verify ID');
      return;
    }
    setBusy(true);
    setMessage('Verifying ID document...');
    try {
      const frontB64 = await fileToBase64(frontFile);
      const backB64 = backFile ? await fileToBase64(backFile) : null;
      const payload = {
        userId: effectiveUserId,
        frontImage: frontB64.split(',')[1],
        backImage: backB64 ? backB64.split(',')[1] : undefined,
        documentType: documentType || undefined,
      };
      const res = await VerificationAPI.verifyId(payload);
      setApiResponse(res);
      setMessage('ID verification submitted');
      setUserId(effectiveUserId);
    } catch (e) {
      setApiResponse(e.data || { error: e.message });
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', fontFamily: 'Inter, system-ui, Arial' }}>
      <h2>Didit Verification Dashboard</h2>
      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        <label>
          <div>User ID (UUID v4)</div>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Leave empty to auto-generate" style={{ width: '100%', padding: 8 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={createSession}>Start Full Verification</button>
          <button disabled={busy} onClick={checkStatus}>Check Status</button>
          <button disabled={busy} onClick={clearAll}>Clear</button>
        </div>
      </div>

      <div style={{ borderTop: '1px solid #eee', margin: '16px 0' }} />

      <h3>Phone Verification</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 8 }}>
        <label>
          <div>Phone Number (+...)</div>
          <input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+15551234567" style={{ width: '100%', padding: 8 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={sendPhone}>Send Code</button>
        </div>
        <label>
          <div>Request ID</div>
          <input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="From send response" style={{ width: '100%', padding: 8 }} />
        </label>
        <label>
          <div>Verification Code</div>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={6} style={{ width: '100%', padding: 8 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={checkPhone}>Verify Code</button>
        </div>
      </div>

      {message && (
        <div style={{ padding: 10, background: '#f5f5f5', marginTop: 8 }}>{message}</div>
      )}
      <div style={{ borderTop: '1px solid #eee', margin: '16px 0' }} />

      <h3>ID Document Verification</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 8 }}>
        <label>
          <div>Document Type (optional)</div>
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} style={{ padding: 8 }}>
            <option value="">Auto-detect</option>
            <option value="passport">Passport</option>
            <option value="id_card">ID Card</option>
            <option value="driver_license">Driver's License</option>
          </select>
        </label>
        <label>
          <div>Front Image (required)</div>
          <input type="file" accept="image/*" onChange={(e) => setFrontFile(e.target.files?.[0] || null)} />
        </label>
        <label>
          <div>Back Image (optional)</div>
          <input type="file" accept="image/*" onChange={(e) => setBackFile(e.target.files?.[0] || null)} />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={verifyId}>Verify ID Document</button>
        </div>
      </div>
      {apiResponse && (
        <pre style={{ background: '#0b1221', color: '#e4e7ef', padding: 12, marginTop: 10, borderRadius: 6, overflowX: 'auto' }}>
{JSON.stringify(apiResponse, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default App;
