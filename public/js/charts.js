/* ==========================================================================
   PulseOps - Dynamic Canvas Chart Engine
   ========================================================================== */

class SmoothLineChart {
    constructor(canvasId, options = {}) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        
        this.maxDataPoints = options.maxDataPoints || 30;
        this.strokeColor = options.strokeColor || '#00f2fe';
        this.fillColor = options.fillColor || 'rgba(0, 242, 254, 0.15)';
        this.unit = options.unit || '%';
        this.maxY = options.maxY || 100;
        
        this.data = new Array(this.maxDataPoints).fill(0);
        this.labels = new Array(this.maxDataPoints).fill('');

        this.initCanvasResize();
    }

    initCanvasResize() {
        const resize = () => {
            if (!this.canvas || !this.canvas.parentElement) return;
            const rect = this.canvas.parentElement.getBoundingClientRect();
            if (rect.width > 10 && rect.height > 10) {
                if (Math.abs(this.canvas.width - rect.width) > 2 || Math.abs(this.canvas.height - rect.height) > 2) {
                    this.canvas.width = rect.width;
                    this.canvas.height = rect.height;
                    this.render();
                }
            }
        };

        window.addEventListener('resize', resize);

        if (window.ResizeObserver && this.canvas.parentElement) {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const cr = entry.contentRect;
                    if (cr.width > 10 && cr.height > 10) {
                        if (Math.abs(this.canvas.width - cr.width) > 2 || Math.abs(this.canvas.height - cr.height) > 2) {
                            this.canvas.width = cr.width;
                            this.canvas.height = cr.height;
                            this.render();
                        }
                    }
                }
            });
            ro.observe(this.canvas.parentElement);
        }

        setTimeout(resize, 60);
    }

    resize() {
        if (!this.canvas || !this.canvas.parentElement) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
            this.render();
        }
    }

    pushData(val, label = '') {
        this.data.shift();
        this.data.push(Number(val) || 0);
        this.labels.shift();
        this.labels.push(label);
        this.render();
    }

    setSeries(dataArray) {
        if (!Array.isArray(dataArray) || dataArray.length === 0) return;
        const pts = dataArray.slice(-this.maxDataPoints);
        const result = [...pts];
        while (result.length < this.maxDataPoints) {
            result.unshift(result[0] !== undefined ? result[0] : 0);
        }
        this.data = result.map(v => Math.max(0, Number(v) || 0));
        this.render();
    }

    render() {
        if (!this.ctx || !this.canvas) return;

        // Auto-recover dimensions if rendered while hidden
        if (this.canvas.width <= 10 || this.canvas.height <= 10) {
            if (this.canvas.parentElement) {
                const rect = this.canvas.parentElement.getBoundingClientRect();
                if (rect.width > 10 && rect.height > 10) {
                    this.canvas.width = rect.width;
                    this.canvas.height = rect.height;
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        const padding = { top: 20, right: 15, bottom: 25, left: 35 };
        const chartW = Math.max(10, w - padding.left - padding.right);
        const chartH = Math.max(10, h - padding.top - padding.bottom);

        // Draw grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;

        const gridSteps = 4;
        for (let i = 0; i <= gridSteps; i++) {
            const y = padding.top + (chartH / gridSteps) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            // Y-axis label
            const val = Math.round(this.maxY - (this.maxY / gridSteps) * i);
            ctx.fillStyle = '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`${val}${this.unit}`, padding.left - 6, y + 3);
        }

        if (this.data.length < 2) return;

        // Calculate points
        const points = this.data.map((val, idx) => {
            const x = padding.left + (chartW / (this.maxDataPoints - 1)) * idx;
            const clampedVal = Math.min(this.maxY, Math.max(0, val));
            const y = padding.top + chartH - (clampedVal / this.maxY) * chartH;
            return { x, y };
        });

        // Draw gradient area
        const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
        grad.addColorStop(0, this.fillColor);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.beginPath();
        ctx.moveTo(points[0].x, padding.top + chartH);
        points.forEach((pt, i) => {
            if (i === 0) {
                ctx.lineTo(pt.x, pt.y);
            } else {
                const prev = points[i - 1];
                const cx = (prev.x + pt.x) / 2;
                ctx.bezierCurveTo(cx, prev.y, cx, pt.y, pt.x, pt.y);
            }
        });
        ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Draw stroke line
        ctx.beginPath();
        points.forEach((pt, i) => {
            if (i === 0) {
                ctx.moveTo(pt.x, pt.y);
            } else {
                const prev = points[i - 1];
                const cx = (prev.x + pt.x) / 2;
                ctx.bezierCurveTo(cx, prev.y, cx, pt.y, pt.x, pt.y);
            }
        });
        ctx.strokeStyle = this.strokeColor;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = this.strokeColor;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0; // Reset glow

        // Draw current value dot
        const lastPt = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(lastPt.x, lastPt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = this.strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

// Dual line chart for Network RX/TX
class DualLineChart {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.maxDataPoints = 30;

        this.rxData = new Array(this.maxDataPoints).fill(0);
        this.txData = new Array(this.maxDataPoints).fill(0);

        this.initResize();
    }

    initResize() {
        const resize = () => {
            if (!this.canvas || !this.canvas.parentElement) return;
            const rect = this.canvas.parentElement.getBoundingClientRect();
            if (rect.width > 10 && rect.height > 10) {
                if (Math.abs(this.canvas.width - rect.width) > 2 || Math.abs(this.canvas.height - rect.height) > 2) {
                    this.canvas.width = rect.width;
                    this.canvas.height = rect.height;
                    this.render();
                }
            }
        };

        window.addEventListener('resize', resize);

        if (window.ResizeObserver && this.canvas.parentElement) {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const cr = entry.contentRect;
                    if (cr.width > 10 && cr.height > 10) {
                        if (Math.abs(this.canvas.width - cr.width) > 2 || Math.abs(this.canvas.height - cr.height) > 2) {
                            this.canvas.width = cr.width;
                            this.canvas.height = cr.height;
                            this.render();
                        }
                    }
                }
            });
            ro.observe(this.canvas.parentElement);
        }

        setTimeout(resize, 60);
    }

    resize() {
        if (!this.canvas || !this.canvas.parentElement) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
            this.render();
        }
    }

    pushData(rxVal, txVal) {
        this.rxData.shift();
        this.rxData.push(Math.max(0, Number(rxVal) || 0));
        this.txData.shift();
        this.txData.push(Math.max(0, Number(txVal) || 0));
        this.render();
    }

    setSeries(rxArray, txArray) {
        const pad = (arr) => {
            const pts = (arr || []).slice(-this.maxDataPoints);
            const res = [...pts];
            while (res.length < this.maxDataPoints) {
                res.unshift(res[0] !== undefined ? res[0] : 0);
            }
            return res.map(v => Math.max(0, Number(v) || 0));
        };
        this.rxData = pad(rxArray);
        this.txData = pad(txArray);
        this.render();
    }

    render() {
        if (!this.ctx || !this.canvas) return;

        // Auto-recover dimensions if rendered while hidden
        if (this.canvas.width <= 10 || this.canvas.height <= 10) {
            if (this.canvas.parentElement) {
                const rect = this.canvas.parentElement.getBoundingClientRect();
                if (rect.width > 10 && rect.height > 10) {
                    this.canvas.width = rect.width;
                    this.canvas.height = rect.height;
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        const padding = { top: 20, right: 15, bottom: 25, left: 45 };
        const chartW = Math.max(10, w - padding.left - padding.right);
        const chartH = Math.max(10, h - padding.top - padding.bottom);

        // Dynamic max scale calculation (values in KB/s)
        const maxVal = Math.max(10, ...this.rxData, ...this.txData) * 1.2;

        // Grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (chartH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            const rawVal = maxVal - (maxVal / 4) * i;
            let valStr = `${rawVal.toFixed(0)} KB/s`;
            if (rawVal >= 1024) {
                valStr = `${(rawVal / 1024).toFixed(1)} MB/s`;
            }

            ctx.fillStyle = '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(valStr, padding.left - 6, y + 3);
        }

        const drawSeries = (data, color) => {
            const points = data.map((val, idx) => {
                const x = padding.left + (chartW / (this.maxDataPoints - 1)) * idx;
                const y = padding.top + chartH - (Math.min(maxVal, Math.max(0, val)) / maxVal) * chartH;
                return { x, y };
            });

            ctx.beginPath();
            points.forEach((pt, i) => {
                if (i === 0) ctx.moveTo(pt.x, pt.y);
                else {
                    const prev = points[i - 1];
                    const cx = (prev.x + pt.x) / 2;
                    ctx.bezierCurveTo(cx, prev.y, cx, pt.y, pt.x, pt.y);
                }
            });
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            ctx.stroke();
            ctx.shadowBlur = 0;
        };

        drawSeries(this.rxData, '#10b981'); // Download - Green
        drawSeries(this.txData, '#8b5cf6'); // Upload - Purple
    }
}

class PulseChartManager {
    constructor(canvasId, options = {}) {
        this.options = options;
        this.canvasId = canvasId;
        if (options.dual) {
            this.chart = new DualLineChart(canvasId);
        } else {
            this.chart = new SmoothLineChart(canvasId, {
                strokeColor: options.color || '#38bdf8',
                fillColor: options.color ? (options.color.startsWith('#') ? options.color + '22' : options.color) : 'rgba(56,189,248,0.15)',
                unit: options.label && options.label.includes('%') ? '%' : ''
            });
        }
    }

    addPoint(val, val2) {
        if (!this.chart) return;
        if (this.chart instanceof DualLineChart) {
            this.chart.pushData(Number(val) || 0, Number(val2) || 0);
        } else if (this.chart instanceof SmoothLineChart) {
            this.chart.pushData(Number(val) || 0);
        }
    }

    setSeries(data1, data2) {
        if (!this.chart) return;
        if (this.chart instanceof DualLineChart) {
            this.chart.setSeries(data1, data2);
        } else if (this.chart instanceof SmoothLineChart) {
            this.chart.setSeries(data1);
        }
    }

    resize() {
        if (this.chart && typeof this.chart.resize === 'function') {
            this.chart.resize();
        }
    }

    reset() {
        if (!this.chart) return;
        if (this.chart.data) {
            this.chart.data = new Array(this.chart.maxDataPoints || 30).fill(0);
        }
        if (this.chart.rxData) {
            this.chart.rxData = new Array(this.chart.maxDataPoints || 30).fill(0);
        }
        if (this.chart.txData) {
            this.chart.txData = new Array(this.chart.maxDataPoints || 30).fill(0);
        }
        this.chart.render();
    }
}

window.PulseChartManager = PulseChartManager;
