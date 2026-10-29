# main.css is linked as `main.css?v=<digest>` (bust_css_cache in al_folio_core's head.liquid),
# but the digest only covers the theme gem's Sass. Edits to this site's own _sass overrides
# (e.g. the theme colour in _sass/_themes.scss) therefore kept the old URL, and returning
# visitors were served their cached, outdated stylesheet. Fold the local partials into the digest.
module SiteCacheBustLocalSass
  class << self
    attr_accessor :sass_dir
  end

  private

  def directory_files_content
    partials = Dir[File.join(SiteCacheBustLocalSass.sass_dir.to_s, "**", "*")].sort.reject { |f| File.directory?(f) }
    super + partials.map { |f| File.read(f) }.join
  end
end

# Prepend once every plugin is loaded: gems listed under `plugins:` (al_folio_core among them) are
# required after this file, and al_folio_core patches the same method without calling super.
Jekyll::Hooks.register :site, :after_init do |site|
  next unless defined?(Jekyll::CacheBust::CacheDigester)

  SiteCacheBustLocalSass.sass_dir = site.in_source_dir("_sass")
  Jekyll::CacheBust::CacheDigester.prepend(SiteCacheBustLocalSass)
end
