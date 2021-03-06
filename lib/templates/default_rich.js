'use strict';

module.exports = `<%
var rich = _.find(self.snippets, snippet => {
  return snippet.tags.indexOf('rich') !== -1 && snippet.tags.indexOf('html5') !== -1;
});

var defaultAspectRatio = 0.75;
var aspectRatio;

if (rich.media.width && rich.media.height) {
  aspectRatio = rich.media.height / rich.media.width;
}
%>

<div class="ez-rich ez-domain-<%= self.domain.replace(/[.]/g, '_') %> ez-block" style="padding-bottom: <%= _.round((aspectRatio || defaultAspectRatio) * 100, 4) %>%;">
  <iframe class="ez-block-frame" src="<%- rich.href %>"></iframe>
</div>`;
