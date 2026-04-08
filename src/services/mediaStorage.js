import COS from "cos-nodejs-sdk-v5";
import { createReadStream } from "fs";
import { copyFile, mkdir, unlink } from "fs/promises";
import { basename, dirname, resolve } from "path";
import { Readable } from "stream";
import { config } from "../config.js";

const localRoot = resolve(config.uploadDir, "shared-gallery");
const tempRoot = resolve(config.uploadDir, ".shared-gallery-tmp");

const cosEnabled = Boolean(
  config.cos.secretId &&
    config.cos.secretKey &&
    config.cos.bucket &&
    config.cos.region
);

const cos = cosEnabled
  ? new COS({
      SecretId: config.cos.secretId,
      SecretKey: config.cos.secretKey,
    })
  : null;

function buildContentDisposition(filename, disposition) {
  const safeName = basename(filename || "download");
  return `${disposition}; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function makePublicCosUrl(key) {
  if (config.cos.publicDomain) {
    return `${config.cos.publicDomain.replace(/\/$/, "")}/${key}`;
  }

  return `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com/${key}`;
}

function getLocalAbsolutePath(storageKey) {
  return resolve(localRoot, storageKey);
}

function putObject(params) {
  return new Promise((resolvePromise, rejectPromise) => {
    cos.putObject(params, (error, data) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(data);
    });
  });
}

function deleteObject(params) {
  return new Promise((resolvePromise, rejectPromise) => {
    cos.deleteObject(params, (error, data) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(data);
    });
  });
}

function getSignedUrl(params) {
  return new Promise((resolvePromise, rejectPromise) => {
    cos.getObjectUrl(params, (error, data) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(data.Url || data.url || "");
    });
  });
}

export async function ensureMediaDirs() {
  await mkdir(localRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
}

export function getUploadTempDir() {
  return tempRoot;
}

export function getStorageInfo() {
  if (cosEnabled) {
    return {
      provider: "cos",
      configured: true,
      directUploadReady: true,
      note: "腾讯云 COS 已配置，当前上传完成后会保存到云端原文件。",
    };
  }

  return {
    provider: "local",
    configured: false,
    directUploadReady: false,
    note: "当前先走本地落盘模式，等 COS 环境变量配置完成后会自动切到腾讯云。",
  };
}

export async function storeUploadedFile({ tempFilePath, storageKey, mimeType }) {
  if (cosEnabled) {
    await putObject({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
      Key: storageKey,
      Body: createReadStream(tempFilePath),
      ContentType: mimeType || "application/octet-stream",
    });

    await unlink(tempFilePath).catch(() => {});

    return {
      storageProvider: "cos",
      storageKey,
      remoteUrl: makePublicCosUrl(storageKey),
    };
  }

  const destination = getLocalAbsolutePath(storageKey);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(tempFilePath, destination);
  await unlink(tempFilePath).catch(() => {});

  return {
    storageProvider: "local",
    storageKey,
    remoteUrl: "",
  };
}

export async function removeStoredObject(asset) {
  if (asset.storage_provider === "cos" && cosEnabled) {
    await deleteObject({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
      Key: asset.storage_key,
    }).catch(() => {});
    return;
  }

  await unlink(getLocalAbsolutePath(asset.storage_key)).catch(() => {});
}

export async function createStoredObjectReadStream(asset) {
  if (asset.storage_provider === "cos" && cosEnabled) {
    const signedUrl = await getSignedUrl({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
      Key: asset.storage_key,
      Sign: true,
      Expires: config.cos.signedUrlExpires,
    });

    const response = await fetch(signedUrl || makePublicCosUrl(asset.storage_key));
    if (!response.ok || !response.body) {
      throw new Error(`Failed to read remote object: ${asset.storage_key}`);
    }

    return {
      stream: Readable.fromWeb(response.body),
      contentType: response.headers.get("content-type") || asset.mime_type || "application/octet-stream",
    };
  }

  return {
    stream: createReadStream(getLocalAbsolutePath(asset.storage_key)),
    contentType: asset.mime_type || "application/octet-stream",
  };
}

export async function sendStoredObject({ req, res, asset, download }) {
  const filename = asset.original_name || "download";
  const disposition = buildContentDisposition(filename, download ? "attachment" : "inline");

  if (asset.storage_provider === "cos" && cosEnabled) {
    const signedUrl = await getSignedUrl({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
      Key: asset.storage_key,
      Sign: true,
      Expires: config.cos.signedUrlExpires,
      Query: {
        "response-content-disposition": disposition,
      },
    });

    res.redirect(signedUrl || makePublicCosUrl(asset.storage_key));
    return;
  }

  res.sendFile(getLocalAbsolutePath(asset.storage_key), {
    headers: {
      "Content-Type": asset.mime_type || "application/octet-stream",
      "Content-Disposition": disposition,
    },
    acceptRanges: true,
    lastModified: true,
  });
}
