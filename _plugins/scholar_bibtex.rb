# Liquid filter used by _layouts/bib.liquid for the "Bib" box. It shows each entry
# exactly as Google Scholar's BibTeX export writes it:
#   - drops the website-only fields listed in filtered_bibtex_keywords (_config.yml);
#   - keeps author marks such as * (the theme's hideCustomBibtex filter strips them);
#   - writes field={value} without spaces and no comma after the last field.
module SiteScholarBibtex
  def scholar_bibtex(input)
    text = input.to_s
    keywords = Array(@context.registers[:site].config["filtered_bibtex_keywords"]).compact
    keywords.each do |keyword|
      text = text.gsub(/^.*\b#{keyword}\b *= *\{.*$\n/, "")
    end
    text = text.gsub(/^(\s+)(\w+) = \{/, '\1\2={')
    text.sub(/,(\s*\}\s*)\z/, '\1')
  end
end

Liquid::Template.register_filter(SiteScholarBibtex)
