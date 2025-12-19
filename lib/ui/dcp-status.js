class DcpStatus extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div style="padding: 10px; background: #2c3e50; color: white; border-radius: 4px; margin: 10px 0;">
        <strong>DCP Status</strong>
        <p>Tokens saved in this session: ${this.getAttribute("saved") || 0}</p>
      </div>
    `;
  }
}

customElements.define("dcp-status", DcpStatus);
