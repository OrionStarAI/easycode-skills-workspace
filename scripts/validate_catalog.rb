#!/usr/bin/env ruby
# frozen_string_literal: true

# Gate for catalog/*.json, the expert templates and MCP market that the skill
# marketplace syncs from this repository. An expert's instructions become a model
# system prompt on every client, so a mistake here should fail the pull request.
# The server validates again on sync and rejects a bad file as a whole.

require "json"
require "uri"

ROOT = File.expand_path("..", __dir__)
ID_PATTERN = /\A[a-z0-9][a-z0-9-]{0,63}\z/
EXPERT_CATEGORIES = %w[technology office creative life].freeze
MCP_CATEGORIES = %w[life office notes data].freeze
MCP_KINDS = %w[mcp skill cli].freeze

def text_errors(value, max, label)
  return ["#{label}: must have zh and en"] unless value.is_a?(Hash)

  %w[zh en].flat_map do |lang|
    text = value[lang]
    if !text.is_a?(String) || text.strip.empty?
      ["#{label}.#{lang}: is required"]
    elsif text.strip.length > max
      ["#{label}.#{lang}: longer than #{max}"]
    else
      []
    end
  end
end

def https?(value)
  value.is_a?(String) && URI.parse(value).is_a?(URI::HTTPS)
rescue URI::InvalidURIError
  false
end

def items_of(raw, max)
  items = raw.is_a?(Hash) ? raw["items"] : nil
  return [[], ["items: must be an array"]] unless items.is_a?(Array)

  errors = []
  errors << "items: must not be empty" if items.empty?
  errors << "items: more than #{max}" if items.length > max
  items.each_with_index { |item, i| errors << "items[#{i}]: must be an object" unless item.is_a?(Hash) }
  [items.select { |item| item.is_a?(Hash) }, errors]
end

def id_errors(items)
  ids = items.map { |item| item["id"] }
  invalid = ids.reject { |id| id.is_a?(String) && ID_PATTERN.match?(id) }.map { |id| "id: invalid #{id.inspect}" }
  invalid + ids.select { |id| ids.count(id) > 1 }.uniq.map { |id| "id: duplicate #{id}" }
end

def expert_errors(raw)
  items, errors = items_of(raw, 100)
  errors += id_errors(items)
  roles = items.select { |t| t["kind"] == "expert" }.map { |t| t["id"] }
  items.each do |t|
    label = t["id"].to_s
    errors << "#{label}: unknown category" unless EXPERT_CATEGORIES.include?(t["category"])
    errors << "#{label}: icon is required" unless t["icon"].is_a?(String) && !t["icon"].empty?
    errors += text_errors(t["name"], 100, "#{label}.name")
    errors += text_errors(t["description"], 2000, "#{label}.description")
    tags = t["tags"]
    if tags.is_a?(Array) && tags.length <= 8
      tags.each_with_index { |tag, i| errors += text_errors(tag, 40, "#{label}.tags[#{i}]") }
    else
      errors << "#{label}: tags must be an array of at most 8"
    end
    case t["kind"]
    when "expert"
      errors += text_errors(t["instructions"], 32_000, "#{label}.instructions")
    when "team"
      errors += text_errors(t["roles"], 500, "#{label}.roles")
      errors << "#{label}: leader is not an expert in this file" unless roles.include?(t["leader"])
      members = t["members"]
      if members.is_a?(Array) && members.length.between?(1, 8)
        errors << "#{label}: repeated member" if members.uniq.length != members.length
        members.each do |member|
          errors << "#{label}: unknown member #{member}" unless roles.include?(member)
          errors << "#{label}: leader listed as a member" if member == t["leader"]
        end
      else
        errors << "#{label}: needs 1-8 members"
      end
    else
      errors << "#{label}: kind must be expert or team"
    end
  end
  errors
end

def mcp_errors(raw)
  items, errors = items_of(raw, 200)
  errors += id_errors(items)
  items.each do |m|
    label = m["id"].to_s
    errors << "#{label}: name is required" unless m["name"].is_a?(String) && !m["name"].strip.empty?
    errors << "#{label}: description is required" unless m["description"].is_a?(String)
    errors << "#{label}: unknown category" unless MCP_CATEGORIES.include?(m["category"])
    kinds = m["kinds"]
    unless kinds.is_a?(Array) && kinds.include?("mcp") && (kinds - MCP_KINDS).empty?
      errors << "#{label}: kinds must include mcp and only known kinds"
    end
    errors << "#{label}: docsUrl must be https" unless https?(m["docsUrl"])
    next unless m.key?("preset")

    preset = m["preset"].is_a?(Hash) ? m["preset"] : {}
    if preset["transport"] == "http" && https?(preset["httpUrl"])
      # This repository is public: a real key here would be published.
      URI.decode_www_form(URI.parse(preset["httpUrl"]).query.to_s).each do |_, value|
        errors << "#{label}: preset query values must be YOUR_ placeholders" unless value.start_with?("YOUR_")
      end
    else
      errors << "#{label}: preset must be http transport with an https URL"
    end
  end
  errors
end

CHECKS = { "expert-templates.json" => :expert_errors, "mcp-servers.json" => :mcp_errors }.freeze

def self_test
  mcp = { "id" => "a", "name" => "A", "description" => "d", "category" => "data", "kinds" => ["mcp"], "docsUrl" => "https://x.test" }
  zh_en = { "zh" => "x", "en" => "x" }
  role = { "id" => "r", "kind" => "expert", "category" => "office", "icon" => "plan", "name" => zh_en,
           "description" => zh_en, "tags" => [], "instructions" => zh_en }
  team = role.reject { |k, _| k == "instructions" }.merge("id" => "t", "kind" => "team", "roles" => zh_en, "leader" => "r", "members" => ["m"])
  cases = [
    [mcp_errors({ "items" => [mcp] }), nil],
    [mcp_errors({ "items" => [] }), /empty/],
    [mcp_errors({ "items" => [mcp, mcp] }), /duplicate/],
    [mcp_errors({ "items" => [mcp.merge("docsUrl" => "http://x.test")] }), /https/],
    [mcp_errors({ "items" => [mcp.merge("preset" => { "transport" => "http", "httpUrl" => "https://x.test/m?key=abc" })] }), /placeholders/],
    [mcp_errors({ "items" => [mcp.merge("preset" => { "transport" => "http", "httpUrl" => "https://x.test/m?key=YOUR_KEY" })] }), nil],
    [expert_errors({ "items" => [role] }), nil],
    [expert_errors({ "items" => [role.merge("id" => "../x")] }), /invalid/],
    [expert_errors({ "items" => [role.merge("name" => { "zh" => "x" })] }), /name\.en/],
    [expert_errors({ "items" => [role, team] }), /unknown member/],
    [expert_errors({ "items" => [role, team.merge("members" => ["r"])] }), /leader listed/],
  ]
  failed = cases.reject do |errors, pattern|
    pattern ? errors.join(" ").match?(pattern) : errors.empty?
  end
  abort("catalog self-test failed: #{failed.inspect}") unless failed.empty?
  puts "catalog self-test passed (#{cases.length} cases)"
end

if ARGV.include?("--self-test")
  self_test
  exit
end

problems = CHECKS.flat_map do |file, check|
  path = File.join(ROOT, "catalog", file)
  next [] unless File.exist?(path)

  begin
    send(check, JSON.parse(File.read(path))).map { |error| "catalog/#{file}: #{error}" }
  rescue JSON::ParserError => e
    ["catalog/#{file}: not valid JSON: #{e.message[0, 120]}"]
  end
end
abort(problems.join("\n")) unless problems.empty?
puts "catalog OK"
