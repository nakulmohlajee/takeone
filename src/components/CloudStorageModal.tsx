import React, { useState, useEffect } from 'react';
import { HardDrive, FileVideo, FileImage, FileAudio, X, Check, Copy } from 'lucide-react';

interface CloudStorageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CloudStorageModal: React.FC<CloudStorageModalProps> = ({ isOpen, onClose }) => {
  const [storageData, setStorageData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch('/api/storage/assets')
      .then((res) => res.json())
      .then((data) => {
        setStorageData(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  const copyUri = (uri: string) => {
    navigator.clipboard.writeText(uri);
    setCopiedUri(uri);
    setTimeout(() => setCopiedUri(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-[#DADCE0] rounded-3xl max-w-3xl w-full p-6 md:p-8 shadow-2xl relative my-8 text-[#202124]">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5F6368] hover:text-[#202124] hover:bg-[#F1F3F4] transition cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-[#E6F4EA] text-[#137333] flex items-center justify-center border border-[#CEEAD6]">
            <HardDrive className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[#137333] uppercase tracking-wider">
                Google Cloud Storage (GCS)
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] bg-[#E8F0FE] text-[#1A73E8] font-semibold border border-[#D2E3FC]">
                Multi-Region Bucket
              </span>
            </div>
            <h2 className="text-xl md:text-2xl font-extrabold text-[#202124] font-['Plus_Jakarta_Sans',sans-serif]">
              TakeOne Media Vault
            </h2>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center space-y-3">
            <div className="w-10 h-10 border-2 border-[#1A73E8] border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-[#5F6368] font-mono">
              Listing objects in gs://takeone-media-vault-prod...
            </p>
          </div>
        ) : storageData ? (
          <div className="space-y-6">
            {/* Bucket Info */}
            <div className="bg-[#F8F9FA] p-4 rounded-2xl border border-[#DADCE0] space-y-2 shadow-2xs">
              <div className="flex flex-wrap items-center justify-between text-xs gap-2">
                <span className="text-[#5F6368]">
                  Bucket: <strong className="text-[#202124] font-mono">gs://{storageData.bucket}</strong>
                </span>
                <span className="text-[#5F6368]">
                  Region: <strong className="text-[#1A73E8]">{storageData.region}</strong>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs pt-1 border-t border-[#DADCE0]">
                <span className="text-[#5F6368]">Total Media Assets: <strong className="text-[#202124]">{storageData.totalAssets}</strong></span>
                <span className="text-[#5F6368]">Storage Used: <strong className="text-[#137333]">{storageData.totalStorageBytes}</strong></span>
              </div>
            </div>

            {/* Asset Table */}
            <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
              {storageData.assets?.map((asset: any, idx: number) => {
                const isVideo = asset.contentType.includes('video');
                const isImage = asset.contentType.includes('image');
                const isAudio = asset.contentType.includes('audio');

                return (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-white border border-[#DADCE0] hover:border-[#1A73E8]/50 flex items-center justify-between gap-3 text-xs transition shadow-2xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-lg bg-[#F1F3F4] text-[#1A73E8]">
                        {isVideo && <FileVideo className="w-4 h-4 text-[#1A73E8]" />}
                        {isImage && <FileImage className="w-4 h-4 text-[#9333EA]" />}
                        {isAudio && <FileAudio className="w-4 h-4 text-[#EA4335]" />}
                      </div>
                      <div className="min-w-0">
                        <span className="font-semibold text-[#202124] block truncate">
                          {asset.name}
                        </span>
                        <span className="text-[11px] text-[#5F6368] font-mono">
                          {asset.size} • {asset.storageClass}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => copyUri(asset.uri)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#F8F9FA] hover:bg-[#F1F3F4] text-[#5F6368] hover:text-[#202124] border border-[#DADCE0] text-[11px] font-medium transition cursor-pointer"
                      title="Copy gs:// URI"
                    >
                      {copiedUri === asset.uri ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-[#34A853]" />
                          <span className="text-[#34A853]">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy URI</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="mt-6 pt-4 border-t border-[#DADCE0] flex items-center justify-between text-xs text-[#5F6368]">
          <span>Google Cloud Storage Blob Storage Provider</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-[#1A73E8] hover:bg-[#1557B0] text-white font-bold transition cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
