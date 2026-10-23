package animalabstract;

/**
 * (4) 把原来的 Animal 接口改成抽象类。
 * 抽象类同样可以定义抽象方法，由子类去重写实现。
 */
public abstract class Animal {
    /** 抽象方法：动物发出的叫声 */
    public abstract void cry();

    /** 抽象方法：动物的种类名称 */
    public abstract String getAnimalName();

    /** 抽象类可以有字段（接口在 Java 8 之前没有） */
    protected String sound = "（未定义）";

    /** 抽象类可以有已实现的方法，子类对象可直接调用 */
    public void show() {
        System.out.print("现在播放" + getAnimalName() + "的声音：");
        cry();
    }
}
