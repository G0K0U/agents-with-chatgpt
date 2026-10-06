import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceCause } from '../src/service/errors.js';
import { highestEffort } from '../src/util/effort-policy.js';

test('highest-effort rejection is machine-readable and sanitized', () => {
  try { highestEffort(['high', 'max'], 'high'); assert.fail('lower effort launched'); }
  catch(error) {
    const cause = serviceCause(error);
    assert.equal(cause.error_code, 'EFFORT_POLICY_VIOLATION');
    assert.equal(cause.failure_layer, 'provider_binding');
    assert.equal(cause.retryable, false);
  }
});

test('permission review deadline retains its failure class without releasing the review body', () => {
  const cause = serviceCause(new Error('The automatic permission approval review did not finish before its deadline. Authorization: Bearer SECRET_REVIEW_BODY'));
  assert.equal(cause.error_code, 'PERMISSION_REVIEW_TIMEOUT');
  assert.equal(cause.retryable, false);
  assert.ok(!JSON.stringify(cause).includes('SECRET_REVIEW_BODY'));
});

test('native missing persistence is distinguishable from an inactive session', () => {
  const absent = serviceCause({error:{code:-32004,message:'Session not found: private session details'}});
  const inactive = serviceCause({error:{code:-32004,message:'Session is not active'}});
  assert.equal(absent.native_session_state, 'NOT_PERSISTED');
  assert.equal(inactive.native_session_state, 'INACTIVE');
  assert.equal(absent.error_code, 'SESSION_STALE');
  assert.ok(!JSON.stringify(absent).includes('private session details'));
});
