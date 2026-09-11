'use strict';

const RECONNECT_MS = 60000;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 50;
const RATE_LIMIT = 30;
const MAX_CLIENTS = 256;
const MAX_ROOMS_PER_IP = 3;
const MAX_SOCKETS_PER_IP = 10;
const CREATE_PER_MIN = 5;
const HTTP_PER_MIN = 60;
const MAX_PAYLOAD = 4096;
const JOIN_IDLE_MS = 30000;
const STATS_MS = 10 * 60 * 1000;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, fallback, min = 1, max = 1e9) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function firstHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip || ip.length > 64) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end < 2) return '';
    ip = ip.slice(1, end);
  } else {
    const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (v4port) ip = v4port[1];
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? ip : '';
  }
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':') && ip.length <= 45) {
    if (ip.split('::').length > 2) return '';
    return ip.toLowerCase();
  }
  return '';
}

function resolveClientIp(req, trustProxy = false) {
  if (trustProxy) {
    const cf = normalizeIp(firstHeader(req.headers, 'cf-connecting-ip'));
    if (cf) return cf;
    const forwarded = firstHeader(req.headers, 'x-forwarded-for');
    if (forwarded) {
      const first = normalizeIp(forwarded.split(',')[0]);
      if (first) return first;
    }
  }
  return normalizeIp(req.socket?.remoteAddress) || 'unknown';
}

function pruneHits(list, now, windowMs) {
  return list.filter(time => now - time < windowMs);
}

function createAbuseState({
  trustProxy,
  createWindowMs,
  httpWindowMs,
  httpPerMin
} = {}) {
  const socketsByIp = new Map();
  const roomsByIp = new Map();
  const createHits = new Map();
  const httpHits = new Map();
  const rejected = { rooms: 0, sockets: 0, create: 0, http: 0, payload: 0, idle: 0 };
  function allowWindow(map, ip, windowMs, limit) {
    const now = Date.now();
    const next = pruneHits(map.get(ip) || [], now, windowMs);
    if (next.length >= limit) { map.set(ip, next); return false; }
    next.push(now);
    map.set(ip, next);
    return true;
  }
  function pruneMaps() {
    const now = Date.now();
    for (const [ip, list] of createHits) {
      const next = pruneHits(list, now, createWindowMs);
      if (next.length) createHits.set(ip, next); else createHits.delete(ip);
    }
    for (const [ip, list] of httpHits) {
      const next = pruneHits(list, now, httpWindowMs);
      if (next.length) httpHits.set(ip, next); else httpHits.delete(ip);
    }
  }
  function addSocket(ip) {
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
  }
  function dropSocket(ip) {
    if (!ip) return;
    const next = (socketsByIp.get(ip) || 0) - 1;
    if (next <= 0) socketsByIp.delete(ip);
    else socketsByIp.set(ip, next);
  }
  function takeRoom(ip, code) {
    let owned = roomsByIp.get(ip);
    if (!owned) { owned = new Set(); roomsByIp.set(ip, owned); }
    owned.add(code);
  }
  function releaseRoom(room) {
    if (!room || room.quotaReleased) return;
    room.quotaReleased = true;
    const owned = roomsByIp.get(room.createdByIp);
    if (!owned) return;
    owned.delete(room.code);
    if (!owned.size) roomsByIp.delete(room.createdByIp);
  }
  function limitedApi(req, res) {
    const ip = resolveClientIp(req, trustProxy);
    if (!allowWindow(httpHits, ip, httpWindowMs, httpPerMin)) {
      rejected.http += 1;
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('請稍後再試');
      return true;
    }
    return false;
  }
  return {
    socketsByIp, roomsByIp, createHits, httpHits, rejected,
    allowWindow, pruneMaps, addSocket, dropSocket, takeRoom, releaseRoom, limitedApi
  };
}

module.exports = {
  RECONNECT_MS, ROOM_TTL_MS, MAX_ROOMS, RATE_LIMIT, MAX_CLIENTS,
  MAX_ROOMS_PER_IP, MAX_SOCKETS_PER_IP, CREATE_PER_MIN, HTTP_PER_MIN,
  MAX_PAYLOAD, JOIN_IDLE_MS, STATS_MS,
  envFlag, envInt, firstHeader, normalizeIp, resolveClientIp, pruneHits, createAbuseState
};
