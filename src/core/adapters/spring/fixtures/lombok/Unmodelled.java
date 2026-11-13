package app;
import lombok.Getter;
import lombok.Setter;
public class Unmodelled {
  @Getter(lazy = true) private final String cached = "c";
  @Setter(onMethod_ = {@Deprecated}) private String marked;
  @Getter private String plain;
}
