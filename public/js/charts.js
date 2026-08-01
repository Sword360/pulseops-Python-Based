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
            const rect = this.canvas.parentElement.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
            this.render();
        };
        window.addEventListener('resize', resize);
        setTimeout(resize, 100);
    }

    pushData(val, label = '') {
        this.data.shift();
        this.data.push(val);
        this.labels.shift();
        this.labels.push(label);
        this.render();
    }

    render() {
        if (!this.ctx) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        const padding = { top: 20, right: 15, bottom: 25, left: 35 };
        const chartW = w - padding.left - padding.right;
        const chartH = h - padding.top - padding.bottom;

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
            const rect = this.canvas.parentElement.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
            this.render();
        };
        window.addEventListener('resize', resize);
        setTimeout(resize, 100);
    }

    pushData(rxVal, txVal) {
        this.rxData.shift();
        this.rxData.push(rxVal);
        this.txData.shift();
        this.txData.push(txVal);
        this.render();
    }

    render() {
        if (!this.ctx) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        const padding = { top: 20, right: 15, bottom: 25, left: 45 };
        const chartW = w - padding.left - padding.right;
        const chartH = h - padding.top - padding.bottom;

        // Dynamic max scale calculation
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
            let valStr = `${rawVal.toFixed(0)} B/s`;
            if (maxVal >= 1024 * 1024) {
                valStr = `${(rawVal / (1024 * 1024)).toFixed(1)} MB/s`;
            } else if (maxVal >= 1024) {
                valStr = `${(rawVal / 1024).toFixed(1)} KB/s`;
            }

            ctx.fillStyle = '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(valStr, padding.left - 6, y + 3);
        }

        const drawSeries = (data, color) => {
            const points = data.map((val, idx) => {
                const x = padding.left + (chartW / (this.maxDataPoints - 1)) * idx;
                const y = padding.top + chartH - (val / maxVal) * chartH;
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
