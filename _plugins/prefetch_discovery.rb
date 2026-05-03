# Runs scripts/prefetch-discovery.mjs once per Jekyll process so sitemap.xml
# and /browse/ always reflect live /v1/sitemap-data. The script preserves
# the existing _data/discovery.yml when the API is unreachable.
# Disable with PREFETCH_DISCOVERY=0; override the endpoint with DISCOVERY_API_URL.

require 'open3'

module TourCoaster
  class << self
    attr_accessor :discovery_prefetched
  end
end

Jekyll::Hooks.register :site, :after_init do |site|
  next if TourCoaster.discovery_prefetched
  next if ENV['PREFETCH_DISCOVERY'] == '0'

  script = File.join(site.source, 'scripts', 'prefetch-discovery.mjs')
  next unless File.exist?(script)

  Jekyll.logger.info 'Discovery:', 'prefetching /v1/sitemap-data'
  out, status = Open3.capture2e('node', script)
  if status.success?
    Jekyll.logger.info 'Discovery:', out.strip unless out.strip.empty?
  else
    Jekyll.logger.warn 'Discovery:', "prefetch failed; keeping existing _data/discovery.yml (#{out.strip})"
  end

  TourCoaster.discovery_prefetched = true
end
