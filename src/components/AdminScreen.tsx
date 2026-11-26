import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CreditCard,
  Download,
  FileAudio,
  Gift,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {AdminOverviewResponse} from '../types';

interface AdminScreenProps {
  initialToken?: string | null;
  onBackHome: () => void;
}

function sanitizeCsvCell(raw: unknown): string {
  const str = raw === null || raw === undefined ? '' : String(raw);
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

function formatCurrencyBrl(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'});
}

function formatDateBr(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR');
}

export const AdminScreen: React.FC<AdminScreenProps> = ({initialToken, onBackHome}) => {
  const [tokenInput, setTokenInput] = useState(initialToken?.trim() || '');
  const [activeToken, setActiveToken] = useState<string | null>(
    initialToken?.trim() ? initialToken.trim() : null
  );
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(initialToken?.trim()));
  const [error, setError] = useState<string | null>(null);
  const scrubbedUrlRef = useRef(false);

  const loadOverview = useCallback(async (tokenToUse: string) => {
    const cleanToken = tokenToUse.trim();
    if (!cleanToken) {
      setActiveToken(null);
      setOverview(null);
      setError('Informe o token de administrador.');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/overview', {
        method: 'GET',
        headers: {
          'x-admin-token': cleanToken,
        },
      });
      const data = (await res.json()) as AdminOverviewResponse & {error?: string};
      if (res.status === 401) {
        setActiveToken(null);
        setOverview(null);
        setError(data.error || 'Token de administrador inválido ou ausente.');
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || `Erro HTTP ${res.status}`);
      }
      setActiveToken(cleanToken);
      setOverview(data);
      if (!scrubbedUrlRef.current && typeof window !== 'undefined' && window.location.search) {
        scrubbedUrlRef.current = true;
        try {
          window.history.replaceState({}, '', window.location.pathname);
        } catch {
          // Ignore history restriction
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar o painel admin.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialToken?.trim()) {
      void loadOverview(initialToken.trim());
    }
  }, [initialToken, loadOverview]);

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void loadOverview(tokenInput);
  };

  const handleLogout = () => {
    setActiveToken(null);
    setOverview(null);
    setTokenInput('');
    setError(null);
  };

  const handleExportCsv = () => {
    if (!overview) return;
    const lines: string[] = [];

    lines.push('SECAO,CAMPO_1,CAMPO_2,CAMPO_3,CAMPO_4,CAMPO_5,CAMPO_6,CAMPO_7');

    for (const p of overview.payments) {
      lines.push(
        [
          'PAGAMENTO',
          p.paymentId,
          p.planId,
          p.status,
          p.value ?? '',
          p.customerName || p.customerEmail || '',
          p.ref || '',
          p.source,
        ]
          .map(sanitizeCsvCell)
          .join(',')
      );
    }

    for (const parent of overview.parents) {
      lines.push(
        [
          'PAI',
          parent.parentId,
          parent.name,
          parent.phone,
          parent.email,
          `conv:${parent.conversions}`,
          `cred:${parent.availableCredits}`,
          parent.createdAt,
        ]
          .map(sanitizeCsvCell)
          .join(',')
      );
    }

    for (const refRow of overview.referrals) {
      lines.push(
        [
          'INDICACAO',
          refRow.ref,
          refRow.parentName || '',
          refRow.parentEmail || '',
          `conversoes:${refRow.conversions}`,
          `ganhos:${refRow.creditsEarned}`,
          `resgatados:${refRow.creditsRedeemed}`,
          `disponiveis:${refRow.availableCredits}`,
        ]
          .map(sanitizeCsvCell)
          .join(',')
      );
    }

    for (const file of overview.bankFiles) {
      lines.push(
        [
          'BANCO_VOZ',
          file.filename,
          file.sizeBytes,
          file.updatedAt,
          file.url,
          '',
          '',
          '',
        ]
          .map(sanitizeCsvCell)
          .join(',')
      );
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `admin-papai-noel-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!activeToken || !overview) {
    return (
      <div className="relative z-10 min-h-[100dvh] flex flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-md rounded-3xl border border-[#D4AF37]/40 bg-[#13151C]/95 p-7 sm:p-8 shadow-2xl space-y-6">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 mx-auto rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/45 flex items-center justify-center text-[#F5D97E]">
              <Lock className="w-7 h-7" aria-hidden="true" />
            </div>
            <h1
              className="text-2xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              Painel Administrativo
            </h1>
            <p className="text-sm text-[#A8A396]">
              Área somente leitura protegida por token de servidor (`ADMIN_TOKEN`).
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-2xl border border-red-400/50 bg-red-950/70 px-4 py-3 text-sm text-red-100 flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="admin-login-token" className="block text-sm font-medium text-[#E5E0D4]">
                Token de Administrador
              </label>
              <div className="relative">
                <KeyRound
                  className="w-4 h-4 text-[#A8A396] absolute left-3.5 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id="admin-login-token"
                  type="password"
                  required
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Digite o ADMIN_TOKEN"
                  autoComplete="off"
                  className="w-full min-h-[48px] pl-10 pr-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full min-h-[50px] rounded-xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:brightness-105 cursor-pointer disabled:opacity-60"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Validando acesso...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                  <span>Entrar no Painel Admin</span>
                </>
              )}
            </button>
          </form>

          <button
            type="button"
            onClick={onBackHome}
            className="w-full min-h-[44px] rounded-xl border border-white/15 text-xs font-medium text-[#D1D5DB] hover:bg-white/5 flex items-center justify-center gap-2 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Voltar para a página inicial</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-[100dvh] pb-16">
      <header className="sticky top-0 z-30 bg-[#0B0C10]/90 backdrop-blur-md border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBackHome}
              className="min-h-[40px] px-3 -ml-2 rounded-xl flex items-center gap-1.5 text-xs font-medium text-[#D1D5DB] hover:text-white hover:bg-white/5 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Início</span>
            </button>
            <h1
              className="text-base sm:text-lg font-semibold text-[#F5D97E] truncate"
              style={{fontFamily: 'var(--font-display)'}}
            >
              Admin · Chamada Mágica (Somente Leitura)
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadOverview(activeToken)}
              disabled={isLoading}
              className="min-h-[40px] px-3.5 rounded-xl border border-white/15 bg-[#13151C] text-xs font-semibold text-[#E5E0D4] flex items-center gap-1.5 hover:bg-white/5 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span className="hidden sm:inline">Atualizar</span>
            </button>

            <button
              type="button"
              onClick={handleExportCsv}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#D4AF37] text-[#0B0C10] text-xs font-bold flex items-center gap-1.5 hover:bg-[#E5C454] cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Exportar CSV</span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Sair do painel admin"
              className="min-h-[40px] px-3 rounded-xl border border-red-400/35 text-xs font-medium text-red-200 hover:bg-red-950/40 flex items-center gap-1.5 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-8 py-8 space-y-8">
        {error && (
          <div
            role="alert"
            className="rounded-2xl border border-red-400/50 bg-red-950/70 px-4 py-3 text-sm text-red-100 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Summary Counters */}
        <section aria-label="Resumo operacional" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#13151C] p-5 space-y-1">
            <p className="text-xs text-[#A8A396] flex items-center gap-1.5">
              <CreditCard className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
              <span>Pagamentos</span>
            </p>
            <p className="text-2xl font-bold text-[#F5D97E] tabular-nums">{overview.payments.length}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#13151C] p-5 space-y-1">
            <p className="text-xs text-[#A8A396] flex items-center gap-1.5">
              <Users className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>Pais cadastrados</span>
            </p>
            <p className="text-2xl font-bold text-[#F7F4EC] tabular-nums">{overview.parents.length}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#13151C] p-5 space-y-1">
            <p className="text-xs text-[#A8A396] flex items-center gap-1.5">
              <Gift className="w-4 h-4 text-amber-300" aria-hidden="true" />
              <span>Indicadores ativos</span>
            </p>
            <p className="text-2xl font-bold text-[#F7F4EC] tabular-nums">{overview.referrals.length}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#13151C] p-5 space-y-1">
            <p className="text-xs text-[#A8A396] flex items-center gap-1.5">
              <FileAudio className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <span>Arquivos no bank</span>
            </p>
            <p className="text-2xl font-bold text-[#F7F4EC] tabular-nums">{overview.bankFiles.length}</p>
          </div>
        </section>

        {/* Table 1: Pagamentos */}
        <section className="rounded-3xl border border-white/10 bg-[#13151C]/95 p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              className="text-lg font-semibold text-[#F5D97E]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              1. Pagamentos (Asaas + Cache Local)
            </h2>
            <span className="text-xs text-[#A8A396]">
              {overview.asaasConfigured
                ? overview.asaasError
                  ? `Asaas API aviso: ${overview.asaasError}`
                  : 'Asaas API conectada'
                : 'ASAAS_API_KEY não configurada (exibindo registros locais)'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-white/10 text-[#A8A396] text-xs uppercase">
                  <th className="py-2.5 pr-4 font-semibold">ID Pagamento</th>
                  <th className="py-2.5 pr-4 font-semibold">Plano</th>
                  <th className="py-2.5 pr-4 font-semibold">Status</th>
                  <th className="py-2.5 pr-4 font-semibold">Valor</th>
                  <th className="py-2.5 pr-4 font-semibold">Cliente</th>
                  <th className="py-2.5 pr-4 font-semibold">Ref</th>
                  <th className="py-2.5 font-semibold">Origem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {overview.payments.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-5 text-center text-xs text-[#8D887C]">
                      Nenhum pagamento registrado até o momento.
                    </td>
                  </tr>
                ) : (
                  overview.payments.map((row) => (
                    <tr key={row.paymentId} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-4 font-mono text-xs text-[#F7F4EC]">{row.paymentId}</td>
                      <td className="py-2.5 pr-4 uppercase text-xs font-semibold text-[#F5D97E]">
                        {row.planId}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-emerald-300 font-medium">{row.status}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-[#E5E0D4]">
                        {formatCurrencyBrl(row.value)}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-[#C7C2B6]">
                        {row.customerName || row.customerEmail || '—'}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-[#A8A396]">
                        {row.ref || '—'}
                      </td>
                      <td className="py-2.5 text-xs text-[#9CA3AF]">{row.source}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Table 2: Cadastros de Pais */}
        <section className="rounded-3xl border border-white/10 bg-[#13151C]/95 p-5 sm:p-6 space-y-4">
          <h2
            className="text-lg font-semibold text-[#F5D97E]"
            style={{fontFamily: 'var(--font-display)'}}
          >
            2. Cadastros de Pais (`parentsMap`)
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-white/10 text-[#A8A396] text-xs uppercase">
                  <th className="py-2.5 pr-4 font-semibold">ID Pai</th>
                  <th className="py-2.5 pr-4 font-semibold">Nome</th>
                  <th className="py-2.5 pr-4 font-semibold">Telefone</th>
                  <th className="py-2.5 pr-4 font-semibold">E-mail</th>
                  <th className="py-2.5 pr-4 font-semibold">Magias</th>
                  <th className="py-2.5 font-semibold">Cadastrado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {overview.parents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-5 text-center text-xs text-[#8D887C]">
                      Nenhum cadastro de responsável registrado nesta instância ainda.
                    </td>
                  </tr>
                ) : (
                  overview.parents.map((p) => (
                    <tr key={p.parentId} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-4 font-mono text-xs text-[#F5D97E]">{p.parentId}</td>
                      <td className="py-2.5 pr-4 text-[#F7F4EC] font-medium">{p.name}</td>
                      <td className="py-2.5 pr-4 text-[#C7C2B6]">{p.phone}</td>
                      <td className="py-2.5 pr-4 text-[#C7C2B6]">{p.email}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-[#E5E0D4]">{p.magicsCount}</td>
                      <td className="py-2.5 text-xs text-[#9CA3AF]">{formatDateBr(p.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Table 3: Indicações e Créditos por Ref */}
        <section className="rounded-3xl border border-white/10 bg-[#13151C]/95 p-5 sm:p-6 space-y-4">
          <h2
            className="text-lg font-semibold text-[#F5D97E]"
            style={{fontFamily: 'var(--font-display)'}}
          >
            3. Indicações e Créditos por `ref` (5 conversões = 1 chamada grátis)
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-white/10 text-[#A8A396] text-xs uppercase">
                  <th className="py-2.5 pr-4 font-semibold">Código `ref`</th>
                  <th className="py-2.5 pr-4 font-semibold">Responsável</th>
                  <th className="py-2.5 pr-4 font-semibold">Conversões Pagas</th>
                  <th className="py-2.5 pr-4 font-semibold">Créditos Ganhos</th>
                  <th className="py-2.5 pr-4 font-semibold">Resgatados</th>
                  <th className="py-2.5 font-semibold">Saldo Disponível</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {overview.referrals.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-5 text-center text-xs text-[#8D887C]">
                      Nenhuma conversão por link de indicação (`?ref=...`) registrada ainda.
                    </td>
                  </tr>
                ) : (
                  overview.referrals.map((r) => (
                    <tr key={r.ref} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 pr-4 font-mono text-xs text-[#F5D97E]">{r.ref}</td>
                      <td className="py-2.5 pr-4 text-xs text-[#C7C2B6]">
                        {r.parentName || r.parentEmail || '—'}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums text-[#F7F4EC] font-semibold">
                        {r.conversions}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums text-[#E5E0D4]">{r.creditsEarned}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-[#A8A396]">{r.creditsRedeemed}</td>
                      <td className="py-2.5 tabular-nums font-bold text-emerald-300">
                        {r.availableCredits}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Table 4: Arquivos do Banco de Vozes */}
        <section className="rounded-3xl border border-white/10 bg-[#13151C]/95 p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              className="text-lg font-semibold text-[#F5D97E]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              4. Arquivos em `public/audio/bank/` ({overview.bankFiles.length})
            </h2>
            <span className="text-xs text-[#8D887C]">
              Atualizado em {formatDateBr(overview.generatedAt)}
            </span>
          </div>

          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead className="sticky top-0 bg-[#13151C]">
                <tr className="border-b border-white/10 text-[#A8A396] text-xs uppercase">
                  <th className="py-2.5 pr-4 font-semibold">Arquivo</th>
                  <th className="py-2.5 pr-4 font-semibold">Tamanho</th>
                  <th className="py-2.5 pr-4 font-semibold">Modificado em</th>
                  <th className="py-2.5 font-semibold">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {overview.bankFiles.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-5 text-center text-xs text-[#8D887C]">
                      Nenhum arquivo de áudio encontrado em `public/audio/bank/`.
                    </td>
                  </tr>
                ) : (
                  overview.bankFiles.map((file) => (
                    <tr key={file.filename} className="hover:bg-white/[0.02]">
                      <td className="py-2 pr-4 font-mono text-xs text-[#F7F4EC]">{file.filename}</td>
                      <td className="py-2 pr-4 tabular-nums text-xs text-[#C7C2B6]">
                        {(file.sizeBytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="py-2 pr-4 text-xs text-[#9CA3AF]">
                        {formatDateBr(file.updatedAt)}
                      </td>
                      <td className="py-2 text-xs">
                        <a
                          href={file.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#F5D97E] hover:underline font-mono"
                        >
                          {file.url}
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
